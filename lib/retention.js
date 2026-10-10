/**
 * Retention policy shared by the v1 and tiered sweeps (FND-BUS-01, #101):
 * which expired events an active consumer still owes, and the unacked policy.
 * @module lib/retention
 */

import { buildFilterSql } from './poll.js';

export const UNACKED_POLICIES = Object.freeze(['retain', 'archive', 'discard']);

/**
 * Resolve and validate the unacked policy from config.
 * @param {object} config
 * @returns {'retain'|'archive'|'discard'}
 */
export function resolveUnackedPolicy(config) {
  const policy = config?.unacked_policy ?? 'retain';
  if (!UNACKED_POLICIES.includes(policy)) {
    throw new Error(`Invalid config: unacked_policy must be one of ${UNACKED_POLICIES.join(', ')} (got '${policy}')`);
  }
  return policy;
}

/**
 * Fill `temp._wb_owed(event_id, cursor_id)` with every expired event an active
 * consumer still owes, and return the per-cursor summary. Must run inside the
 * caller's transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {number} now
 * @returns {Array<{cursor_id: string, count: number, oldest_event_id: number, newest_event_id: number}>}
 */
export function collectOwedExpired(db, now) {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _wb_owed (
    event_id INTEGER NOT NULL, cursor_id TEXT NOT NULL, PRIMARY KEY (event_id, cursor_id))`);
  db.exec('DELETE FROM temp._wb_owed');
  const cursors = db.prepare(`
    SELECT c.cursor_id, c.last_event_id, s.event_type_filter
    FROM cursors c JOIN subscriptions s ON s.subscription_id = c.subscription_id
    WHERE c.deregistered_at IS NULL AND s.deregistered_at IS NULL
  `).all();
  for (const c of cursors) {
    const { where, params } = buildFilterSql(c.event_type_filter);
    db.prepare(`
      INSERT OR IGNORE INTO temp._wb_owed (event_id, cursor_id)
      SELECT event_id, :cursor_id FROM events
      WHERE expires_at < :now AND event_id > :last_event_id AND ${where}
    `).run({ ...params, cursor_id: c.cursor_id, now, last_event_id: c.last_event_id });
  }
  // In-flight retries (handler failed, backoff pending) are owed regardless of
  // cursor position.
  db.prepare(`
    INSERT OR IGNORE INTO temp._wb_owed (event_id, cursor_id)
    SELECT da.event_id, da.cursor_id FROM delivery_attempts da
    JOIN events e ON e.event_id = da.event_id
    JOIN cursors c ON c.cursor_id = da.cursor_id
    WHERE e.expires_at < ? AND c.deregistered_at IS NULL
  `).run(now);
  return db.prepare(`
    SELECT cursor_id, COUNT(*) AS count, MIN(event_id) AS oldest_event_id, MAX(event_id) AS newest_event_id
    FROM temp._wb_owed GROUP BY cursor_id ORDER BY cursor_id
  `).all();
}

