'use strict';

const { query, queryOne, insert, execute } = require('../config/db');
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
   */
  async findActiveByUserId(userId) {
    return queryOne(
      `SELECT m.*, s.plan AS owner_plan, s.status AS owner_status, s.license_key AS owner_license_key,
              s.expiry_date AS owner_expiry_date, s.seats AS owner_seats, s.user_id AS owner_user_id,
              u.name AS owner_name, u.email AS owner_email
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
   * Every team row about this person as an invitee or member — by account, or
   * by address for an invitation not accepted yet — with the owner's name.
   * For the self-service export; never token_hash.
   */
  async listForExport(userId, email) {
    return query(
      `SELECT m.id, m.email, m.status, m.invited_at, m.accepted_at, u.name AS owner_name
         FROM team_members m
         JOIN subscriptions s ON s.id = m.subscription_id
         JOIN users u ON u.id = s.user_id
        WHERE m.user_id = ? OR m.email = ?
        ORDER BY m.invited_at DESC`,
      [userId, String(email).toLowerCase()]
    );
  },

  async create({ subscriptionId, email, tokenHash, invitedBy }) {
    const id = await insert(
      `INSERT INTO team_members (subscription_id, email, token_hash, status, invited_by)
       VALUES (?, ?, ?, 'invited', ?)`,
      [subscriptionId, String(email).toLowerCase(), tokenHash, invitedBy || null]
    );
    return TeamMember.findById(id);
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
