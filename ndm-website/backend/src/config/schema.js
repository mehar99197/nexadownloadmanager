'use strict';

const { query, execute } = require('../config/db');

async function initSchema() {
  await execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
      email_verified TINYINT(1) NOT NULL DEFAULT 0,
      banned TINYINT(1) NOT NULL DEFAULT 0,
      refresh_token_hash VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_email (email),
      INDEX idx_role (role),
      INDEX idx_refresh_token (refresh_token_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

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

  await execute(`
    CREATE TABLE IF NOT EXISTS license_activations (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      subscription_id INT UNSIGNED NOT NULL,
      device_fingerprint VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_license_device (subscription_id, device_fingerprint),
      INDEX idx_activation_subscription (subscription_id),
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    INSERT IGNORE INTO license_activations (subscription_id, device_fingerprint)
    SELECT id, device_fingerprint FROM subscriptions WHERE device_fingerprint IS NOT NULL
  `);

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
      changelog TEXT,
      is_latest TINYINT(1) NOT NULL DEFAULT 0,
      published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_is_latest (is_latest)
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
