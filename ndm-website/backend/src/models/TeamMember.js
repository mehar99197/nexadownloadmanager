'use strict';

const { query, queryOne, execute, withTransaction } = require('../config/db');
const config = require('../config/env');

/**
 * People invited onto a Team licence.
 *
 * A Team subscription is one key with five concurrent seats. Before invites
 * the owner had to paste that key into a chat; now they invite by email, the
 * invitee accepts from their own account and the key appears on THEIR
 * dashboard. A row is `invited` until accepted (token hash set, user_id
 * null) and `active` afterwards (user_id set, token gone). Nothing here
 * changes how seats are counted — the app still holds seats per device.
 */
const TeamMember = {
  async findById(id) {
    return queryOne('SELECT * FROM team_members WHERE id = ?', [id]);
  },

  async findByTokenHash(hash) {
    return queryOne(
      `SELECT m.*, s.plan AS owner_plan, s.status AS owner_status, s.user_id AS owner_user_id,
              u.name AS owner_name
         FROM team_members m
         JOIN subscriptions s ON s.id = m.subscription_id
         JOIN users u ON u.id = s.user_id
        WHERE m.token_hash = ?`,
      [hash]
    );
  },

  async findBySubscriptionAndEmail(subscriptionId, email) {
    return queryOne(
      'SELECT * FROM team_members WHERE subscription_id = ? AND email = ?',
      [subscriptionId, String(email).toLowerCase()]
    );
  },

  async listBySubscription(subscriptionId) {
    return query(
      `SELECT m.id, m.email, m.user_id, m.status, m.invited_at, m.accepted_at, u.name AS user_name
         FROM team_members m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.subscription_id = ?
        ORDER BY m.status ASC, m.invited_at ASC`,
      [subscriptionId]
    );
  },

  async countBySubscription(subscriptionId) {
    const r = await queryOne(
      'SELECT COUNT(*) AS cnt FROM team_members WHERE subscription_id = ?', [subscriptionId]
    );
    return r ? Number(r.cnt) || 0 : 0;
  },

  /**
   * The team this user belongs to as a member (not owner), with the owner's
   * subscription attached so the caller can tell whether it is still usable.
   *
   * `owner_banned` rides along because a membership draws on the OWNER's
   * plan: a banned owner's plan must not keep entitling their members. The
   * licence-key path already answers `banned` for it; a member's device token
   * reaches the plan through here instead (utils/accountPlan.js).
   */
  async findActiveByUserId(userId) {
    return queryOne(
      `SELECT m.*, s.plan AS owner_plan, s.status AS owner_status, s.license_key AS owner_license_key,
              s.expiry_date AS owner_expiry_date, s.seats AS owner_seats, s.user_id AS owner_user_id,
              u.name AS owner_name, u.email AS owner_email, u.banned AS owner_banned
         FROM team_members m
         JOIN subscriptions s ON s.id = m.subscription_id
         JOIN users u ON u.id = s.user_id
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY m.accepted_at DESC LIMIT 1`,
      [userId]
    );
  },

  /**
   * Has this invitation aged out? (AUDIT.md M-12)
   *
   * Kept next to the model rather than in the routes because two of them read
   * a token — the pre-sign-in lookup and the accept — and a rule enforced in
   * one but not the other is the same bug with an extra step.
   *
   * Only meaningful for a row still in 'invited': an accepted member's
   * invited_at is just history, and their membership does not expire.
   */
  isExpired(invite) {
    if (!invite || invite.status !== 'invited') return false;
    const invitedAt = invite.invited_at ? new Date(invite.invited_at).getTime() : NaN;
    // A row with no usable timestamp is treated as live. Refusing it would
    // turn a data oddity into somebody unable to join a team they paid for.
    if (!Number.isFinite(invitedAt)) return false;
    return Date.now() - invitedAt > config.TEAM_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
  },

  /**
   * Seats this roster holds, the owner included: every member plus every
   * invitation that can still be accepted. An expired invitation holds nothing
   * (AUDIT.md M-12). This is the ONE definition of "held" — the roster's
   * `used`/`canInvite` and the invite route's TEAM_FULL both come from it, so
   * the page can no longer offer a seat the route then refuses.
   */
  heldSeats(members) {
    return members.filter((m) => !TeamMember.isExpired(m)).length + 1;
  },

  /**
   * Add an invitation only if the plan still has a seat for it.
   *
   * Count and insert run in one transaction with the owner's subscription row
   * locked FOR UPDATE (the lock Subscription.acquireSeat takes), so invitations
   * sent at the same moment queue behind each other instead of all reading the
   * same "room for one more". Seats are read from the locked row.
   *
   * → { ok: true, member }
   *   | { ok: false, reason: 'team_full', seats }
   *   | { ok: false, reason: 'already_invited' }
   *   | { ok: false, reason: 'not_found' }
   */
  async createWithinSeats({ subscriptionId, email, tokenHash, invitedBy }) {
    const address = String(email).toLowerCase();
    // The member SELECT below is a plain read taken AFTER the lock is granted,
    // so its snapshot already includes whatever the previous holder committed.
    const outcome = await withTransaction(async (connection) => {
      const [subs] = await connection.execute(
        'SELECT seats FROM subscriptions WHERE id = ? FOR UPDATE', [subscriptionId]
      );
      if (!subs.length) return { ok: false, reason: 'not_found' };
      const seats = Math.max(1, Number(subs[0].seats) || 1);
      const [members] = await connection.execute(
        'SELECT email, status, invited_at FROM team_members WHERE subscription_id = ?', [subscriptionId]
      );
      if (members.some((m) => String(m.email).toLowerCase() === address))
        return { ok: false, reason: 'already_invited' };
      if (TeamMember.heldSeats(members) >= seats) return { ok: false, reason: 'team_full', seats };
      const [result] = await connection.execute(
        `INSERT INTO team_members (subscription_id, email, token_hash, status, invited_by)
         VALUES (?, ?, ?, 'invited', ?)`,
        [subscriptionId, address, tokenHash, invitedBy || null]
      );
      return { ok: true, id: result.insertId };
    });
    if (!outcome.ok) return outcome;
    return { ok: true, member: await TeamMember.findById(outcome.id) };
  },

  /** New token for a still-pending invite (resend). */
  async rotateToken(id, tokenHash) {
    await execute(
      `UPDATE team_members SET token_hash = ?, invited_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'invited'`,
      [tokenHash, id]
    );
  },

  async accept(id, userId) {
    const result = await execute(
      `UPDATE team_members
          SET user_id = ?, status = 'active', token_hash = NULL, accepted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'invited'`,
      [userId, id]
    );
    return (result.affectedRows || 0) > 0;
  },

  async remove(id, subscriptionId) {
    const result = await execute(
      'DELETE FROM team_members WHERE id = ? AND subscription_id = ?', [id, subscriptionId]
    );
    return (result.affectedRows || 0) > 0;
  },
};

module.exports = TeamMember;
