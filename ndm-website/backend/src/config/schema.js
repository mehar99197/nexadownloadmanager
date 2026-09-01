'use strict';

const { query, execute } = require('../config/db');

// Idempotent column/index helpers: MySQL has no ADD COLUMN IF NOT EXISTS, so
// attempt the ALTER and swallow the "already exists" error (same pattern as
// the uq_payments_stripe_id index below).
async function addColumnIfMissing(table, definition) {
  try {
    await execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (err) {
    if (err && err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
}

// Widen/retype a column only when it is not already what we want, so a boot
// against an up-to-date database does no ALTER at all (MySQL would otherwise
// rebuild the table on every start).
async function ensureColumnType(table, column, expectedType, definition) {
  const rows = await query(
    `SELECT DATA_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (!rows.length || String(rows[0].DATA_TYPE).toLowerCase() === expectedType) return;
  await execute(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
}

// Widening an ENUM cannot use ensureColumnType: information_schema reports
// DATA_TYPE='enum' for every enum column regardless of its members, so the
// comparison would always match and the ALTER would never run. COLUMN_TYPE
// carries the full "enum('user','admin')" text, which is what actually changes.
async function ensureColumnDefinition(table, column, expectedColumnType, definition) {
  const rows = await query(
    `SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (!rows.length) return;
  const current = String(rows[0].COLUMN_TYPE).toLowerCase().replace(/\s+/g, '');
  if (current === expectedColumnType) return;
  await execute(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
}

async function addIndexIfMissing(table, definition) {
  try {
    await execute(`ALTER TABLE ${table} ADD INDEX ${definition}`);
  } catch (err) {
    if (err && err.code !== 'ER_DUP_KEYNAME') throw err;
  }
}

// A UNIQUE index can also fail on existing duplicate rows (ER_DUP_ENTRY), which
// must not be swallowed silently the way a re-run (ER_DUP_KEYNAME) is.
async function addUniqueIndexIfMissing(table, definition) {
  try {
    await execute(`ALTER TABLE ${table} ADD UNIQUE INDEX ${definition}`);
  } catch (err) {
    if (err && err.code !== 'ER_DUP_KEYNAME') throw err;
  }
}

// Drop a NOT NULL constraint once, and only when it is still there. Checking
// IS_NULLABLE first keeps a boot against an up-to-date database free of the
// table rebuild that MODIFY COLUMN would otherwise trigger every time.
async function ensureColumnNullable(table, column, definition) {
  const rows = await query(
    `SELECT IS_NULLABLE FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (!rows.length || String(rows[0].IS_NULLABLE).toUpperCase() === 'YES') return;
  await execute(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
}

async function initSchema() {
  await execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL DEFAULT NULL,
      role ENUM('user', 'admin', 'root') NOT NULL DEFAULT 'user',
      email_verified TINYINT(1) NOT NULL DEFAULT 0,
      banned TINYINT(1) NOT NULL DEFAULT 0,
      google_id VARCHAR(64) NULL DEFAULT NULL,
      avatar_url VARCHAR(500) NULL DEFAULT NULL,
      refresh_token_hash VARCHAR(255) DEFAULT NULL,
      admin_refresh_token_hash VARCHAR(64) NULL DEFAULT NULL,
      root_refresh_token_hash VARCHAR(64) NULL DEFAULT NULL,
      trial_used TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_users_google_id (google_id),
      INDEX idx_email (email),
      INDEX idx_role (role),
      INDEX idx_refresh_token (refresh_token_hash),
      INDEX idx_admin_refresh_token (admin_refresh_token_hash),
      INDEX idx_root_refresh_token (root_refresh_token_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Existing databases: admin SPA session cookie + one-shot Pro trial flag.
  await addColumnIfMissing('users', 'admin_refresh_token_hash VARCHAR(64) NULL DEFAULT NULL');
  await addIndexIfMissing('users', 'idx_admin_refresh_token (admin_refresh_token_hash)');
  await addColumnIfMissing('users', 'trial_used TINYINT(1) NOT NULL DEFAULT 0');

  // Databases created before the creator tier carry ENUM('user','admin'). Widen
  // them so 'root' is storable; no-ops once the enum already has three members.
  await ensureColumnDefinition(
    'users', 'role', "enum('user','admin','root')",
    "ENUM('user', 'admin', 'root') NOT NULL DEFAULT 'user'"
  );
  await addColumnIfMissing('users', 'root_refresh_token_hash VARCHAR(64) NULL DEFAULT NULL');
  await addIndexIfMissing('users', 'idx_root_refresh_token (root_refresh_token_hash)');

  // Control-panel two-factor auth. The TOTP secret is AES-GCM encrypted
  // (utils/totp.js); `totp_enabled` flips only after a first code verifies, so
  // a half-finished setup never locks anyone out. Recovery codes are stored as
  // a JSON array of SHA-256 hashes and removed one by one as they are used.
  await addColumnIfMissing('users', 'totp_secret VARCHAR(255) NULL DEFAULT NULL');
  await addColumnIfMissing('users', 'totp_enabled TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('users', 'totp_recovery TEXT NULL DEFAULT NULL');

  // "Continue with Google". `google_id` is Google's immutable subject claim —
  // never the email, which a user can change at Google. It is UNIQUE so one
  // Google account can only ever be linked to one Nexa account.
  await addColumnIfMissing('users', 'google_id VARCHAR(64) NULL DEFAULT NULL');
  await addColumnIfMissing('users', 'avatar_url VARCHAR(500) NULL DEFAULT NULL');
  await addUniqueIndexIfMissing('users', 'uq_users_google_id (google_id)');

  // An account created through Google has no password at all. Storing a random
  // hash instead would be indistinguishable from a real one, so the column is
  // nullable and NULL is read as "password sign-in not available for this
  // account" (routes/auth.js answers PASSWORD_NOT_SET). Such a user can still
  // adopt a password through the ordinary forgot-password flow.
  await ensureColumnNullable('users', 'password_hash', 'VARCHAR(255) NULL DEFAULT NULL');

  await execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      plan ENUM('free', 'pro', 'team') NOT NULL DEFAULT 'free',
      status ENUM('active', 'expired', 'cancelled') NOT NULL DEFAULT 'active',
      license_key VARCHAR(50) NOT NULL UNIQUE,
      device_fingerprint VARCHAR(255) DEFAULT NULL,
      seats INT UNSIGNED NOT NULL DEFAULT 1,
      start_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiry_date DATETIME NULL DEFAULT NULL,
      trial_ends_at DATETIME NULL DEFAULT NULL,
      trial_reminder_sent_at DATETIME NULL DEFAULT NULL,
      stripe_subscription_id VARCHAR(255) DEFAULT NULL,
      stripe_customer_id VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_license_key (license_key),
      INDEX idx_status (status),
      INDEX idx_plan (plan),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // TIMESTAMP overflows in 2038, while free licenses intentionally live far
  // into the future. Keep this column compatible with that policy on existing DBs.
  await execute('ALTER TABLE subscriptions MODIFY COLUMN expiry_date DATETIME NULL');

  // Existing databases: end of the no-card Pro trial (NULL = not a trial).
  await addColumnIfMissing('subscriptions', 'trial_ends_at DATETIME NULL DEFAULT NULL');
  // Existing databases: stamped when the "trial ending" email went out, so the
  // nightly job can never mail the same person twice.
  await addColumnIfMissing('subscriptions', 'trial_reminder_sent_at DATETIME NULL DEFAULT NULL');

  await execute(`
    CREATE TABLE IF NOT EXISTS license_activations (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      subscription_id INT UNSIGNED NOT NULL,
      device_fingerprint VARCHAR(255) NOT NULL,
      device_name VARCHAR(120) NULL DEFAULT NULL,
      lease_expires_at DATETIME NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_license_device (subscription_id, device_fingerprint),
      INDEX idx_activation_subscription (subscription_id),
      INDEX idx_activation_lease (subscription_id, lease_expires_at),
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    INSERT IGNORE INTO license_activations (subscription_id, device_fingerprint)
    SELECT id, device_fingerprint FROM subscriptions WHERE device_fingerprint IS NOT NULL
  `);

  // Team invites: who has been asked onto a Team licence and who accepted.
  // Cascades with the subscription (a cancelled-and-deleted team takes its
  // roster with it) and with the member's own account.
  await execute(`
    CREATE TABLE IF NOT EXISTS team_members (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      subscription_id INT UNSIGNED NOT NULL,
      email VARCHAR(255) NOT NULL,
      user_id INT UNSIGNED NULL DEFAULT NULL,
      token_hash CHAR(64) NULL DEFAULT NULL,
      status ENUM('invited', 'active') NOT NULL DEFAULT 'invited',
      invited_by INT UNSIGNED NULL DEFAULT NULL,
      invited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      accepted_at TIMESTAMP NULL DEFAULT NULL,
      UNIQUE KEY uq_team_member (subscription_id, email),
      INDEX idx_team_member_user (user_id),
      INDEX idx_team_member_token (token_hash),
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Seats are concurrent, not permanent: a device holds one only while its
  // lease is unexpired, so uninstalling or closing the app frees it without an
  // admin having to revoke anything. Rows predating this are given no lease,
  // which correctly reads as "not currently in use".
  await addColumnIfMissing('license_activations', 'device_name VARCHAR(120) NULL DEFAULT NULL');
  await addColumnIfMissing('license_activations', 'lease_expires_at DATETIME NULL DEFAULT NULL');
  await addIndexIfMissing('license_activations', 'idx_activation_lease (subscription_id, lease_expires_at)');

  await execute(`
    CREATE TABLE IF NOT EXISTS payments (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      currency VARCHAR(3) NOT NULL DEFAULT 'usd',
      plan VARCHAR(20) NOT NULL,
      billing_cycle ENUM('monthly', 'yearly') NOT NULL,
      stripe_payment_id VARCHAR(255) DEFAULT NULL,
      status ENUM('paid', 'failed', 'refunded') NOT NULL DEFAULT 'paid',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_status (status),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    DELETE p1 FROM payments p1
    JOIN payments p2
      ON p1.stripe_payment_id IS NOT NULL
     AND p1.stripe_payment_id = p2.stripe_payment_id
     AND p1.id > p2.id
  `);
  try {
    await execute('ALTER TABLE payments ADD UNIQUE INDEX uq_payments_stripe_id (stripe_payment_id)');
  } catch (err) {
    if (err && err.code !== 'ER_DUP_KEYNAME') throw err;
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id VARCHAR(255) PRIMARY KEY,
      event_type VARCHAR(100) NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      status ENUM('processing', 'processed', 'failed') NOT NULL DEFAULT 'processing',
      attempts INT UNSIGNED NOT NULL DEFAULT 1,
      last_error VARCHAR(500) DEFAULT NULL,
      received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP NULL DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_stripe_event_status (status),
      INDEX idx_stripe_event_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS license_email_deliveries (
      event_id VARCHAR(255) PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      license_key VARCHAR(50) NOT NULL,
      plan VARCHAR(20) NOT NULL,
      status ENUM('processing', 'sent', 'failed') NOT NULL DEFAULT 'processing',
      attempts INT UNSIGNED NOT NULL DEFAULT 1,
      last_error VARCHAR(500) DEFAULT NULL,
      sent_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_license_email_status (status),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      rating TINYINT UNSIGNED NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT NOT NULL,
      status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_status (status),
      INDEX idx_rating (rating),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS releases (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      version VARCHAR(50) NOT NULL,
      windows_url VARCHAR(500) DEFAULT '',
      linux_url VARCHAR(500) DEFAULT '',
      windows_sha256 VARCHAR(64) NULL DEFAULT NULL,
      linux_sha256 VARCHAR(64) NULL DEFAULT NULL,
      windows_file VARCHAR(255) NULL DEFAULT NULL,
      linux_file VARCHAR(255) NULL DEFAULT NULL,
      windows_filename VARCHAR(255) NULL DEFAULT NULL,
      linux_filename VARCHAR(255) NULL DEFAULT NULL,
      windows_size BIGINT UNSIGNED NULL DEFAULT NULL,
      linux_size BIGINT UNSIGNED NULL DEFAULT NULL,
      download_count INT UNSIGNED NOT NULL DEFAULT 0,
      changelog TEXT,
      is_latest TINYINT(1) NOT NULL DEFAULT 0,
      published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_is_latest (is_latest)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Existing databases: artifact checksums + real download counter.
  await addColumnIfMissing('releases', 'windows_sha256 VARCHAR(64) NULL DEFAULT NULL');
  await addColumnIfMissing('releases', 'linux_sha256 VARCHAR(64) NULL DEFAULT NULL');
  await addColumnIfMissing('releases', 'download_count INT UNSIGNED NOT NULL DEFAULT 0');

  // Uploaded installers. `*_file` is the opaque on-disk name under
  // RELEASE_UPLOAD_DIR; `*_filename` is the original name we send back in
  // Content-Disposition. The legacy `*_url` columns stay so releases published
  // before uploads existed keep resolving — the download route prefers a file.
  await addColumnIfMissing('releases', 'windows_file VARCHAR(255) NULL DEFAULT NULL');
  await addColumnIfMissing('releases', 'linux_file VARCHAR(255) NULL DEFAULT NULL');
  await addColumnIfMissing('releases', 'windows_filename VARCHAR(255) NULL DEFAULT NULL');
  await addColumnIfMissing('releases', 'linux_filename VARCHAR(255) NULL DEFAULT NULL');
  await addColumnIfMissing('releases', 'windows_size BIGINT UNSIGNED NULL DEFAULT NULL');
  await addColumnIfMissing('releases', 'linux_size BIGINT UNSIGNED NULL DEFAULT NULL');

  // One row per version. The catalog once held three "0.1.0" rows, which the
  // public changelog listed three times. Keep, per version, the row marked
  // latest, else the one with downloads, else the newest; then enforce it.
  await execute(`
    DELETE r1 FROM releases r1
    JOIN releases r2
      ON r1.version = r2.version AND r1.id <> r2.id
     AND (r2.is_latest > r1.is_latest
          OR (r2.is_latest = r1.is_latest AND r2.download_count > r1.download_count)
          OR (r2.is_latest = r1.is_latest AND r2.download_count = r1.download_count AND r2.id > r1.id))
  `);
  try {
    await execute('ALTER TABLE releases ADD UNIQUE INDEX uq_releases_version (version)');
  } catch (err) {
    if (err && err.code !== 'ER_DUP_KEYNAME') throw err;
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS ads (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      body VARCHAR(300) NOT NULL DEFAULT '',
      image_url VARCHAR(500) NULL DEFAULT NULL,
      target_url VARCHAR(500) NOT NULL,
      cta_label VARCHAR(40) NOT NULL DEFAULT 'Learn more',
      placement ENUM('app_banner', 'app_sidebar', 'app_complete') NOT NULL DEFAULT 'app_banner',
      active TINYINT(1) NOT NULL DEFAULT 1,
      weight INT UNSIGNED NOT NULL DEFAULT 1,
      starts_at DATETIME NULL DEFAULT NULL,
      ends_at DATETIME NULL DEFAULT NULL,
      impressions INT UNSIGNED NOT NULL DEFAULT 0,
      clicks INT UNSIGNED NOT NULL DEFAULT 0,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ads_serving (active, placement),
      INDEX idx_ads_window (starts_at, ends_at),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Existing databases: the schedule columns started life as TIMESTAMP, which
  // tops out at 2038-01-19 — an admin scheduling an ad to end after that got a
  // 500 from MySQL. DATETIME spans to year 9999 and, with the connection pinned
  // to UTC, stores exactly the same instants. Re-running the MODIFY is a no-op.
  await ensureColumnType('ads', 'starts_at', 'datetime', 'DATETIME NULL DEFAULT NULL');
  await ensureColumnType('ads', 'ends_at', 'datetime', 'DATETIME NULL DEFAULT NULL');

  await execute(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NULL DEFAULT NULL,
      name VARCHAR(100) NOT NULL DEFAULT '',
      email VARCHAR(254) NOT NULL,
      topic VARCHAR(20) NOT NULL DEFAULT 'general',
      message TEXT NOT NULL,
      status ENUM('new', 'open', 'replied', 'closed', 'spam') NOT NULL DEFAULT 'new',
      ip VARCHAR(45) NULL DEFAULT NULL,
      user_agent VARCHAR(300) NULL DEFAULT NULL,
      email_delivered TINYINT(1) NOT NULL DEFAULT 0,
      replied_at DATETIME NULL DEFAULT NULL,
      replied_by INT UNSIGNED NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_contact_status (status, created_at),
      INDEX idx_contact_email (email),
      INDEX idx_contact_created (created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (replied_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Every reply an admin sends from the panel, kept even after the thread is
  // closed so the conversation can be read back in full. ON DELETE CASCADE:
  // deleting a thread takes its replies with it; the author is SET NULL so a
  // departed admin's account can still be removed.
  await execute(`
    CREATE TABLE IF NOT EXISTS contact_replies (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      message_id INT UNSIGNED NOT NULL,
      admin_user_id INT UNSIGNED NULL DEFAULT NULL,
      admin_name VARCHAR(255) NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      delivered TINYINT(1) NOT NULL DEFAULT 0,
      delivery_error VARCHAR(255) NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_contact_reply_message (message_id, created_at),
      FOREIGN KEY (message_id) REFERENCES contact_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      admin_user_id INT UNSIGNED NULL,
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id INT UNSIGNED NULL,
      summary VARCHAR(255) NOT NULL,
      metadata TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_created (created_at),
      INDEX idx_audit_entity (entity_type, entity_id),
      FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // eslint-disable-next-line no-console
  console.log('[db] schema initialized');
}

module.exports = { initSchema };
