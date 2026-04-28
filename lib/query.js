/**
 * Cross-tier query resolver — implements the warm-spill algorithm from
 * DESIGN-v2.md §5.4. The data plane's load-bearing correctness piece.
 *
 * Contract:
 *   - poll() and subscribe() read live first; if cursor falls behind the
 *     oldest live row (or live is empty), we spill into the relevant warm
 *     bucket(s), dedupe by event_id (live copy wins), then return rows in
 *     strict ascending event_id order.
 *   - Routine sweep-driven catchup never raises WB-003. WB-003 fires only
 *     when no buckets cover the gap AND live also does not include the
 *     next event_id.
 *   - The crash-window duplicate (sweep crashed between warm-COMMIT and
 *     live-DELETE) is harmless: warm + live both contain the row with
 *     identical event_id; dedupe collapses to one copy (the live one).
 *
 * Order invariant (round-3 fix): collect → dedupe → sort → truncate to
 * batchSize → advance cursor. Truncating before dedupe could discard the
 * kept copy and ship the to-be-discarded copy.
 *
 * @module lib/query
 */

import { bucketsCoveringRange } from './archive.js';
import { WBError } from './errors.js';

// SQLite hard ceiling is 125; reserve 2 for live + temp.
const ATTACH_CEILING = 123;

/**
 * Resolve a poll request across live + warm tiers.
 *
 * @param {import('better-sqlite3').Database} liveDb - connection to bus.db
 * @param {string} archDir - absolute path to archive/ directory
 * @param {object} opts
 * @param {number} opts.lastEventId - cursor; events with event_id > lastEventId are returned
 * @param {{ event_type?: string, domain?: string, subdomain?: string }} [opts.filter]
 * @param {number} [opts.batchSize=100]
 * @returns {Array<object>} rows in ascending event_id order, length <= batchSize
 */
export function pollResolve(liveDb, archDir, opts) {
  const { lastEventId, filter, batchSize = 100 } = opts;

  if (typeof lastEventId !== 'number' || !Number.isInteger(lastEventId) || lastEventId < 0) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: 'lastEventId must be a non-negative integer',
      received: lastEventId,
    });
  }

  // Step 1: probe the live tier for its oldest event matching the filter
  const minLive = probeLiveMin(liveDb, filter);

  // Step 2: cursor within live window? Fast path — single SELECT, no spill.
  if (minLive !== null && lastEventId >= minLive) {
    return queryLive(liveDb, lastEventId, filter, batchSize);
  }

  // Step 3: spill required. Determine the gap we need warm to cover.
  const gapStart = lastEventId;
  const gapEnd = (minLive === null) ? Number.MAX_SAFE_INTEGER : minLive - 1;

  const buckets = bucketsCoveringRange(archDir, gapStart, gapEnd);

  // No live, no covering buckets — cursor is past everything we have.
  // This is the only case where the resolver returns empty without raising.
  if (buckets.length === 0 && minLive === null) {
    return [];
  }

  // Cursor < minLive but no covering bucket exists → events were deleted
  // (e.g. archive_to: none). This is the WB-003 case.
  if (buckets.length === 0 && minLive !== null && lastEventId + 1 < minLive) {
    throw new WBError('WB-003', 'CURSOR_BEHIND_TTL_WINDOW', {
      message: 'cursor points to events that have been deleted from both tiers',
      last_event_id: lastEventId,
      oldest_available: minLive,
    });
  }

  // Step 4: ATTACH each covering bucket in turn, collect warm rows.
  const warmRows = [];
  const attachCount = Math.min(buckets.length, ATTACH_CEILING);

  for (let i = 0; i < attachCount; i++) {
    const { filepath } = buckets[i];
    if (warmRows.length >= batchSize) break;

    const remaining = batchSize - warmRows.length;
    const rows = readBucket(liveDb, filepath, i, lastEventId, filter, remaining);
    warmRows.push(...rows);
  }

  // Step 5: include any live rows that match. This catches the crash-window
  // duplicate AND the case where the cursor straddles the live boundary
  // (e.g. spill returned partial, fill the rest from live).
  const liveRoom = batchSize - warmRows.length;
  const liveRows = liveRoom > 0
    ? queryLive(liveDb, lastEventId, filter, liveRoom + warmRows.length /* over-fetch for dedup */)
    : [];

  // Step 6: dedupe → sort → truncate. ORDER MATTERS.
  // Live copy wins (round-3 spec): we add warm first, then live; the dedupe
  // helper keeps the LAST occurrence per event_id, so live overwrites warm.
  let rows = dedupePreferLive(warmRows, liveRows);
  rows.sort((a, b) => a.event_id - b.event_id);
  if (rows.length > batchSize) rows = rows.slice(0, batchSize);

  return rows;
}

/**
 * Probe live tier for the smallest event_id matching the filter.
 * Returns null when the live tier is empty or no rows match.
 */
function probeLiveMin(db, filter) {
  const where = whereClause(filter);
  const sql = `SELECT MIN(event_id) AS min_id FROM events ${where.sql}`;
  const row = db.prepare(sql).get(...where.params);
  return row && row.min_id != null ? row.min_id : null;
}

function queryLive(db, lastEventId, filter, limit) {
  const where = whereClause(filter, { extra: 'event_id > ?' });
  const sql = `SELECT * FROM events ${where.sql} ORDER BY event_id ASC LIMIT ?`;
  return db.prepare(sql).all(...where.params, lastEventId, limit);
}

/**
 * ATTACH a warm bucket, run a filtered range query, DETACH. Throws WB-013
 * if the bucket cannot be opened (locked by VACUUM / compact, missing,
 * or corrupt).
 */
function readBucket(liveDb, filepath, idx, lastEventId, filter, limit) {
  const alias = `warm_${idx}`;
  const escaped = filepath.replace(/'/g, "''");
  let attached = false;

  try {
    liveDb.exec(`ATTACH DATABASE '${escaped}' AS ${alias}`);
    attached = true;

    const where = whereClause(filter, { extra: 'event_id > ?' });
    const sql = `SELECT * FROM ${alias}.events ${where.sql}
                 ORDER BY event_id ASC LIMIT ?`;
    return liveDb.prepare(sql).all(...where.params, lastEventId, limit);
  } catch (e) {
    throw new WBError('WB-013', 'SPILL_BUCKET_UNAVAILABLE', {
      message: `spill bucket unavailable: ${filepath}`,
      path: filepath,
      cause: e.message,
    });
  } finally {
    if (attached) {
      try { liveDb.exec(`DETACH DATABASE ${alias}`); } catch (_e) { /* best effort */ }
    }
  }
}

/**
 * Build a WHERE clause from a filter spec. Optional `extra` is appended
 * with AND if filter has any predicates, otherwise becomes the WHERE.
 */
function whereClause(filter, opts = {}) {
  const parts = [];
  const params = [];
  if (filter) {
    if (filter.event_type) { parts.push('event_type = ?'); params.push(filter.event_type); }
    if (filter.domain)     { parts.push('domain = ?');     params.push(filter.domain); }
    if (filter.subdomain)  { parts.push('subdomain = ?');  params.push(filter.subdomain); }
  }
  if (opts.extra) parts.push(opts.extra);
  if (parts.length === 0) return { sql: '', params };
  return { sql: 'WHERE ' + parts.join(' AND '), params };
}

/**
 * Dedupe two row arrays by event_id, preferring the LIVE copy when the
 * same event_id appears in both. Implementation: insert warm first, then
 * live; Map.set semantics overwrite, so the live copy wins.
 *
 * Exposed for test introspection.
 */
export function dedupePreferLive(warmRows, liveRows) {
  const map = new Map();
  for (const r of warmRows) map.set(r.event_id, r);
  for (const r of liveRows) map.set(r.event_id, r);
  return Array.from(map.values());
}
