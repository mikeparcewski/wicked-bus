/**
 * Dead-letter queue inspection.
 * @module lib/dlq
 *
 * Step 1 surface area for issue #3. Provides a read-only view of the
 * dead_letters table so consumers (and operators) can inspect events that
 * exhausted retries. Writes to dead_letters / delivery_attempts are owned by
 * the consumer's poll loop in step 1, and by the managed subscribe() helper
 * in step 2.
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
