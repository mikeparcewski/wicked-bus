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


/** One day in ms. */
export const DAY_MS = 86_400_000;

/**
 * Default ceiling on how long an active consumer's unacked backlog is kept
 * under `unacked_policy: 'retain'` (operator ruling 2026-10-10, #101).
 */
export const DEFAULT_UNACKED_RETENTION_DAYS = 30;

/**
 * Resolve and validate `config.unacked_retention_days` (default 30). An owed
 * expired event emitted longer ago than this is ARCHIVED (never discarded),
 * even under 'retain', so an abandoned registered cursor cannot hold its
 * backlog in the live tier forever.
 * @param {object} config
 * @returns {number}
 */
export function resolveRetentionCapDays(config) {
  const days = config?.unacked_retention_days ?? DEFAULT_UNACKED_RETENTION_DAYS;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid config: unacked_retention_days must be a positive number (got '${days}')`);
  }
  return days;
}

/**
 * The owed pairs collected by collectOwedExpired(), each flagged `over_cap`
 * when its event was emitted more than `capDays` before `now`. Must run in the
 * same transaction, before `temp._wb_owed` is cleared.
 * @param {import('better-sqlite3').Database} db
 * @param {number} now
 * @param {number} capDays
 * @returns {Array<{event_id: number, cursor_id: string, over_cap: boolean}>}
 */
export function owedPairsWithCap(db, now, capDays) {
  return db.prepare(`
    SELECT o.event_id, o.cursor_id, (e.emitted_at < ?) AS over_cap
    FROM temp._wb_owed o JOIN events e ON e.event_id = o.event_id
    ORDER BY o.cursor_id, o.event_id
  `).all(now - capDays * DAY_MS).map((r) => ({ ...r, over_cap: r.over_cap === 1 }));
}

/**
 * Build the per-consumer reconciliation report from owed pairs. `fateOf(pair)`
 * returns `{ disposition, reason }` for each pair:
 *   disposition 'retained' | 'archived' | 'discarded'
 *   reason      'unacked_policy'        the configured policy decided
 *               'retention_cap'         archived: older than unacked_retention_days
 *               'retention_cap_pending' over the cap but not moved this pass
 *                                       (locked bucket / batch limit); retried next sweep
 * The report always carries the policy's own count key plus `archived` when
 * the cap archived anything, and one cursor line per (cursor, disposition, reason).
 * @param {Array<{event_id: number, cursor_id: string, over_cap: boolean}>} pairs
 * @param {(pair: object) => {disposition: string, reason: string}} fateOf
 * @param {{policy: string, capDays: number}} opts
 */
export function buildUnackedReport(pairs, fateOf, { policy, capDays }) {
  const policyVerb = policy === 'retain' ? 'retained' : policy === 'archive' ? 'archived' : 'discarded';
  const counts = { [policyVerb]: new Set() };
  const lines = new Map();
  for (const p of pairs) {
    const { disposition, reason } = fateOf(p);
    (counts[disposition] ||= new Set()).add(p.event_id);
    const key = `${p.cursor_id}\u0000${disposition}\u0000${reason}`;
    const line = lines.get(key) || {
      cursor_id: p.cursor_id, count: 0, oldest_event_id: p.event_id, newest_event_id: p.event_id, disposition, reason,
    };
    line.count++;
    line.oldest_event_id = Math.min(line.oldest_event_id, p.event_id);
    line.newest_event_id = Math.max(line.newest_event_id, p.event_id);
    lines.set(key, line);
  }
  const report = {};
  for (const [verb, ids] of Object.entries(counts)) report[verb] = ids.size;
  report.retention_cap_days = capDays;
  report.cursors = [...lines.values()].sort((a, b) =>
    a.cursor_id < b.cursor_id ? -1 : a.cursor_id > b.cursor_id ? 1
      : a.disposition < b.disposition ? -1 : a.disposition > b.disposition ? 1 : 0);
  return report;
}
