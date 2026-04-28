/**
 * v2 tiered sweep — moves TTL'd events from live (`bus.db`) to monthly warm
 * buckets (`archive/bus-YYYY-MM[suffix].db`). Implements DESIGN-v2.md §5.1
 * (cross-tier resolution invariant) + §5.5 (sweep backpressure).
 *
 * Atomicity per batch:
 *   1. SELECT eligible events from live (TTL'd, oldest-first, capped at batch).
 *   2. For each target bucket, INSERT the events (separate per-bucket
 *      transaction). COMMIT.
 *   3. DELETE the same event_ids from live (separate transaction). COMMIT.
 *
 * Crash between (2) and (3): events are visible in BOTH tiers. The warm-spill
 * resolver in lib/query.js dedupes by event_id with live-wins precedence.
 *
 * The v1 `lib/sweep.js` remains intact for backcompat. Callers opt in to v2
 * by invoking runSweepV2 explicitly. A future migration will flip the default.
 *
 * @module lib/sweep-v2
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  archiveDir,
  ensureArchiveDir,
  createBucket,
  getBucketMeta,
  sealBucket,
  listBuckets,
} from './archive.js';

const require = createRequire(import.meta.url);

export const DEFAULT_BATCH_SIZE          = 5000;
export const DEFAULT_BUCKET_MAX_BYTES    = 10 * 1024 * 1024 * 1024; // 10 GB
export const DEFAULT_LIVE_BLOAT_BYTES    = 1  * 1024 * 1024 * 1024; // 1 GB
export const DEFAULT_LIVE_BLOAT_ROWS     = 1_000_000;
const LOCKS_SUBDIR = '.locks';

/**
 * Run a single batch of v2 tiered sweep.
 *
 * @param {import('better-sqlite3').Database} db - live bus.db connection
 * @param {object} [config]
 * @param {string} [config.data_dir]              - parent dir for archive/. Defaults to env.
 * @param {number} [config.sweep_batch_size]      - rows per batch, default 5000
 * @param {number} [config.bucket_max_bytes]      - auto-split threshold, default 10 GB
 * @param {number} [config.live_bloat_bytes]      - WB-012 trigger, default 1 GB
 * @param {number} [config.live_bloat_rows]       - WB-012 trigger, default 1M rows
 * @param {number} [config.now]                   - test override for "now"
 * @returns {{
 *   events_moved: number,
 *   buckets_touched: string[],
 *   buckets_skipped_locked: string[],
 *   wal_checkpoint: object,
 *   bloat_warning: { error: string, code: string }|null,
 * }}
 */
export function runSweepV2(db, config = {}) {
  const dataDir = resolveDataDir(config);
  const archDir = archiveDir(dataDir);
  ensureArchiveDir(archDir);
  ensureLocksDir(archDir);

  const batchSize       = config.sweep_batch_size  ?? DEFAULT_BATCH_SIZE;
  const bucketMaxBytes  = config.bucket_max_bytes  ?? DEFAULT_BUCKET_MAX_BYTES;
  const now             = config.now               ?? Date.now();

  // Step 1: pick eligible candidates, oldest-first
  const candidates = db.prepare(
    `SELECT * FROM events WHERE dedup_expires_at < ? ORDER BY event_id ASC LIMIT ?`
  ).all(now, batchSize);

  // Bloat warning evaluates even on empty-candidate batches (a live tier that
  // is huge but not yet TTL'd is still a problem operators want to see).
  if (candidates.length === 0) {
    return {
      ...emptyResult(),
      bloat_warning: bloatWarningIfNeeded(db, dataDir, config),
    };
  }

  // Step 2: group by target bucket (by emitted_at month + size-aware suffix)
  const groups = groupByTargetBucket(candidates, archDir, bucketMaxBytes);

  // Step 3: write each group to its bucket. Locked buckets are deferred
  // (next sweep cycle will pick them up).
  const bucketsTouched = [];
  const bucketsSkipped = [];
  const movedIds = [];

  for (const [bucketName, events] of groups) {
    if (isBucketLocked(archDir, bucketName)) {
      bucketsSkipped.push(bucketName);
      continue;
    }
    const filepath = path.join(archDir, bucketName);
    insertBatchIntoBucket(filepath, events);
    bucketsTouched.push(bucketName);
    for (const e of events) movedIds.push(e.event_id);
  }

  // Step 4: DELETE from live in a separate transaction (preserves the
  // invariant that warm-COMMIT happens BEFORE live-DELETE).
  if (movedIds.length > 0) {
    deleteFromLive(db, movedIds);
  }

  // Step 5: WAL checkpoint with PASSIVE → 3×busy → RESTART policy.
  // Counter resets per batch invocation (round-3 council fix, Pi).
  const checkpoint = walCheckpointWithEscalation(db);

  // Step 6: bloat warning if live still huge after this batch
  const bloat = bloatWarningIfNeeded(db, dataDir, config);

  return {
    events_moved: movedIds.length,
    buckets_touched: bucketsTouched,
    buckets_skipped_locked: bucketsSkipped,
    wal_checkpoint: checkpoint,
    bloat_warning: bloat,
  };
}

// ---------------------------------------------------------------------------
// Bucket targeting + auto-split
// ---------------------------------------------------------------------------

function groupByTargetBucket(events, archDir, bucketMaxBytes) {
  const cache = new Map();
  const groups = new Map();
  for (const ev of events) {
    const month = monthKey(ev.emitted_at);
    let bucketName = cache.get(month);
    if (!bucketName) {
      bucketName = chooseBucketForMonth(archDir, month, bucketMaxBytes);
      cache.set(month, bucketName);
    }
    if (!groups.has(bucketName)) groups.set(bucketName, []);
    groups.get(bucketName).push(ev);
  }
  return groups;
}

/**
 * Pick the bucket name for events in the given YYYY-MM month. Auto-split rules:
 *  - If no bucket for this month → `bus-YYYY-MM.db`.
 *  - If the latest bucket is sealed → next suffix.
 *  - If the latest bucket exceeds bucketMaxBytes on disk → next suffix.
 *  - Otherwise → reuse the latest bucket.
 *
 * Suffixes go: '' (bare), 'a', 'b', 'c', ...; 27th split is unsupported and
 * throws (we'd need 'aa' etc., out of scope for v2).
 */
function chooseBucketForMonth(archDir, month, bucketMaxBytes) {
  const prefix = `bus-${month}`;
  const all = listBuckets(archDir)
    .map(p => path.basename(p))
    .filter(name => name === `${prefix}.db` || name.startsWith(`${prefix}`));

  if (all.length === 0) return `${prefix}.db`;

  // Sort: bare suffix first, then a, b, c… (lex sort of full filename)
  all.sort();
  const latest = all[all.length - 1];
  const latestPath = path.join(archDir, latest);

  let needNext = false;
  try {
    const meta = getBucketMeta(latestPath);
    if (meta.sealed_at) needNext = true;
  } catch (_e) { /* unreadable — leave as-is, sweep will skip via lock or fail loud */ }

  if (!needNext) {
    try {
      const stat = fs.statSync(latestPath);
      if (stat.size >= bucketMaxBytes) needNext = true;
    } catch (_e) { /* missing — let createBucket recreate */ }
  }

  if (!needNext) return latest;

  // Need a new bucket. Seal the current one (so its max_event_id is locked
  // before the next bucket starts taking writes) and pick the next suffix.
  try { sealBucket(latestPath); } catch (_e) { /* best-effort */ }
  return nextSuffixedName(latest, prefix);
}

function nextSuffixedName(latest, prefix) {
  // latest is "bus-YYYY-MM.db" or "bus-YYYY-MM<letter>.db"
  const tail = latest.slice(prefix.length, -3); // strip prefix + ".db"
  if (tail === '') return `${prefix}a.db`;
  if (tail.length === 1 && tail >= 'a' && tail < 'z') {
    return `${prefix}${String.fromCharCode(tail.charCodeAt(0) + 1)}.db`;
  }
  throw new Error(`unable to allocate next suffix for ${latest} (out of single-letter range)`);
}

function monthKey(timestampMs) {
  const d = new Date(timestampMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// Bucket I/O
// ---------------------------------------------------------------------------

function insertBatchIntoBucket(filepath, events) {
  const Database = require('better-sqlite3');
  let db;
  if (fs.existsSync(filepath)) {
    db = new Database(filepath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } else {
    db = createBucket(filepath, {
      minEventId: events[0].event_id,
      maxEventId: events[events.length - 1].event_id,
    });
  }

  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, event_type, domain, subdomain, payload, schema_version,
        idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata,
        parent_event_id, session_id, correlation_id, producer_id,
        origin_node_id, registry_schema_version, payload_cas_sha
      ) VALUES (
        @event_id, @event_type, @domain, @subdomain, @payload, @schema_version,
        @idempotency_key, @emitted_at, @expires_at, @dedup_expires_at, @metadata,
        @parent_event_id, @session_id, @correlation_id, @producer_id,
        @origin_node_id, @registry_schema_version, @payload_cas_sha
      )
    `);

    const tx = db.transaction((rows) => {
      for (const r of rows) insert.run(normalizeForInsert(r));
    });
    tx(events);

    // Update _meta min/max from current bucket contents (covers re-runs and
    // out-of-order arrivals).
    const range = db.prepare(
      'SELECT MIN(event_id) AS min_id, MAX(event_id) AS max_id FROM events'
    ).get();
    if (range && range.min_id != null) {
      const setMeta = db.prepare(
        'INSERT OR REPLACE INTO _meta(k, v) VALUES (?, ?)'
      );
      const metaTx = db.transaction(() => {
        setMeta.run('min_event_id', String(range.min_id));
        setMeta.run('max_event_id', String(range.max_id));
      });
      metaTx();
    }
  } finally {
    db.close();
  }
}

/**
 * Coerce v1-only rows (without the v2 columns) into the full insert shape.
 */
function normalizeForInsert(row) {
  return {
    event_id:                 row.event_id,
    event_type:               row.event_type,
    domain:                   row.domain,
    subdomain:                row.subdomain ?? '',
    payload:                  row.payload,
    schema_version:           row.schema_version ?? '1.0.0',
    idempotency_key:          row.idempotency_key,
    emitted_at:               row.emitted_at,
    expires_at:               row.expires_at,
    dedup_expires_at:         row.dedup_expires_at,
    metadata:                 row.metadata ?? null,
    parent_event_id:          row.parent_event_id ?? null,
    session_id:               row.session_id ?? null,
    correlation_id:           row.correlation_id ?? null,
    producer_id:              row.producer_id ?? null,
    origin_node_id:           row.origin_node_id ?? null,
    registry_schema_version:  row.registry_schema_version ?? null,
    payload_cas_sha:          row.payload_cas_sha ?? null,
  };
}

// ---------------------------------------------------------------------------
// Live-tier delete (separate transaction, preserves invariant)
// ---------------------------------------------------------------------------

function deleteFromLive(db, eventIds) {
  // Chunk to stay under SQLite's parameter limit on very old builds. Modern
  // better-sqlite3 supports tens of thousands, but 500-at-a-time is a safe cap.
  const CHUNK = 500;
  const tx = db.transaction((ids) => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      db.prepare(`DELETE FROM events WHERE event_id IN (${placeholders})`).run(...slice);
    }
  });
  tx(eventIds);
}

// ---------------------------------------------------------------------------
// WAL checkpoint with PASSIVE → 3×busy → RESTART policy
// ---------------------------------------------------------------------------

function walCheckpointWithEscalation(db) {
  let busyCount = 0;
  for (let i = 0; i < 3; i++) {
    const r = db.pragma('wal_checkpoint(PASSIVE)', { simple: false });
    if (!isCheckpointBusy(r)) {
      return { mode: 'PASSIVE', busy_runs: busyCount, result: r };
    }
    busyCount++;
  }
  // 3× busy → RESTART once. Counter resets at the start of the next batch
  // (this function is called once per batch).
  const restart = db.pragma('wal_checkpoint(RESTART)', { simple: false });
  return { mode: 'RESTART', busy_runs: busyCount, result: restart };
}

function isCheckpointBusy(pragmaResult) {
  // better-sqlite3 returns an array of one row { busy, log, checkpointed }
  if (!Array.isArray(pragmaResult) || pragmaResult.length === 0) return false;
  const row = pragmaResult[0];
  return row && row.busy === 1;
}

// ---------------------------------------------------------------------------
// Bloat warning (WB-012)
// ---------------------------------------------------------------------------

function bloatWarningIfNeeded(db, dataDir, config) {
  const liveBytes  = config.live_bloat_bytes ?? DEFAULT_LIVE_BLOAT_BYTES;
  const liveRows   = config.live_bloat_rows  ?? DEFAULT_LIVE_BLOAT_ROWS;

  let exceeded = false;
  let detail = {};

  // Row count
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  if (countRow && countRow.n >= liveRows) {
    exceeded = true;
    detail.row_count = countRow.n;
    detail.row_threshold = liveRows;
  }

  // File size — best-effort; resolveDbPath handles cross-platform layout
  if (!exceeded) {
    try {
      const dbFile = path.join(dataDir, 'bus.db');
      const stat = fs.statSync(dbFile);
      if (stat.size >= liveBytes) {
        exceeded = true;
        detail.live_bytes = stat.size;
        detail.bytes_threshold = liveBytes;
      }
    } catch (_e) { /* file not accessible — skip */ }
  }

  if (!exceeded) return null;
  return {
    error: 'WB-012',
    code: 'LIVE_TIER_BLOAT_WARNING',
    context: { message: 'live tier exceeds configured threshold', ...detail },
  };
}

// ---------------------------------------------------------------------------
// Lock detection (advisory file lock at archive/.locks/<bucket>.lock)
// ---------------------------------------------------------------------------

function ensureLocksDir(archDir) {
  fs.mkdirSync(path.join(archDir, LOCKS_SUBDIR), { recursive: true });
}

function isBucketLocked(archDir, bucketName) {
  const lockPath = path.join(archDir, LOCKS_SUBDIR, `${bucketName}.lock`);
  return fs.existsSync(lockPath);
}

/**
 * Test/operator helper: acquire an advisory bucket lock (used by compact +
 * export commands; exported for sweep test setup).
 */
export function lockBucketForTesting(archDir, bucketName) {
  ensureLocksDir(archDir);
  const lockPath = path.join(archDir, LOCKS_SUBDIR, `${bucketName}.lock`);
  fs.writeFileSync(lockPath, String(process.pid));
  return lockPath;
}

export function unlockBucketForTesting(archDir, bucketName) {
  const lockPath = path.join(archDir, LOCKS_SUBDIR, `${bucketName}.lock`);
  try { fs.unlinkSync(lockPath); } catch (_e) { /* not present */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDataDir(config) {
  return config.data_dir || process.env.WICKED_BUS_DATA_DIR;
}

function emptyResult() {
  return {
    events_moved: 0,
    buckets_touched: [],
    buckets_skipped_locked: [],
    wal_checkpoint: null,
    bloat_warning: null,
  };
}
