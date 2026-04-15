/**
 * Dead-letter queue inspection and operator controls.
 * @module lib/dlq
 *
 * Read-only listing, replay request, and drop. The managed subscribe() helper
 * in lib/subscribe.js owns the corresponding write paths (DLQ insertion on
 * retry exhaustion, replay drain on each poll cycle).
 */

import { WBError } from './errors.js';

/**
 * List dead-lettered events, most recent first.
 *
 * Caveat: dead_letters rows are denormalized snapshots of the originating
 * event taken at DLQ time. The original row in `events` may have been swept
 * by `dedup_expires_at` (24h default) by the time the DLQ entry is read, so
 * the returned `payload` / `event_type` / `domain` / `subdomain` reflect the
 * event as it existed when it failed, not the current state of `events`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {string} [opts.plugin] - Filter to a single subscriber plugin
 * @param {string} [opts.cursorId] - Filter to a single cursor
 * @param {number} [opts.limit=100] - Max rows to return
 * @returns {object[]} Dead letter rows with `payload` parsed from JSON
 */
export function listDeadLetters(db, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;

  const conditions = [];
  const params = { limit };

  if (opts.plugin) {
    conditions.push(`dl.subscription_id IN (
      SELECT subscription_id FROM subscriptions WHERE plugin = :plugin
    )`);
    params.plugin = opts.plugin;
  }

  if (opts.cursorId) {
    conditions.push('dl.cursor_id = :cursor_id');
    params.cursor_id = opts.cursorId;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      dl.dl_id,
      dl.cursor_id,
      dl.subscription_id,
      dl.event_id,
      dl.event_type,
      dl.domain,
      dl.subdomain,
      dl.payload,
      dl.emitted_at,
      dl.attempts,
      dl.last_error,
      dl.dead_lettered_at,
      dl.replay_requested_at,
      s.plugin
    FROM dead_letters dl
    LEFT JOIN subscriptions s ON s.subscription_id = dl.subscription_id
    ${where}
    ORDER BY dl.dead_lettered_at DESC, dl.dl_id DESC
    LIMIT :limit
  `;

  const rows = db.prepare(sql).all(params);

  return rows.map(row => ({
    ...row,
    payload: parsePayload(row.payload),
  }));
}

/**
 * Mark a dead-lettered event for replay. The next tick of the managed
 * subscribe() loop for this cursor will drain pending replays before normal
 * polling. Replay is a single attempt — no automatic retry. On success the
 * DLQ row is deleted; on failure `replay_requested_at` is cleared and
 * `attempts` / `last_error` are updated so the operator can re-inspect.
 *
 * Caveat: if the handler re-emits during replay, the original event's
 * `idempotency_key` may already have been swept from `events` (24h
 * `dedup_expires_at`), so the re-emission will not be deduped against the
 * original. Replay is for recovery after fixing a bug, not transparent retry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} dlId - dl_id of the dead_letters row to replay
 * @returns {{ replayed: boolean, dl_id: number, replay_requested_at: number }}
 */
export function replayDeadLetter(db, dlId) {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE dead_letters
    SET replay_requested_at = ?
    WHERE dl_id = ?
  `).run(now, dlId);

  if (result.changes === 0) {
    throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
      message: `Dead letter not found: ${dlId}`,
      dl_id: dlId,
      reason: 'dead letter row not found',
    });
  }

  return { replayed: true, dl_id: dlId, replay_requested_at: now };
}

/**
 * Permanently drop a dead-lettered event. Use this when an event is
 * unrecoverable and the operator does not want it consuming DLQ slots.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} dlId
 * @returns {{ dropped: boolean, dl_id: number }}
 */
export function dropDeadLetter(db, dlId) {
  const result = db.prepare('DELETE FROM dead_letters WHERE dl_id = ?').run(dlId);
  if (result.changes === 0) {
    throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
      message: `Dead letter not found: ${dlId}`,
      dl_id: dlId,
      reason: 'dead letter row not found',
    });
  }
  return { dropped: true, dl_id: dlId };
}

function parsePayload(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: 'dead_letters row has malformed JSON payload',
      reason: err.message,
    });
  }
}
