/**
 * Archive bucket lifecycle for the v2 tiered-storage warm tier.
 *
 * Each warm bucket is an independent SQLite file at
 * `<data_dir>/archive/bus-YYYY-MM[suffix].db`. Files are independent —
 * corrupting one bucket affects only the events in that month/split.
 *
 * Each bucket carries a `_meta` table (NOT a fictitious PRAGMA) holding
 * `min_event_id`, `max_event_id`, `created_at`, and `sealed_at`. The query
 * resolver reads these via normal SELECT to decide which buckets to ATTACH
 * during a warm-spill (see lib/query.js and DESIGN-v2.md §5.4).
 *
 * Buckets without a `sealed_at` value are still being filled by sweep and
 * are conservatively treated as covering up to MAX_SAFE_INTEGER until sealed.
 *
 * @module lib/archive
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const BUCKET_FILE_RE = /^bus-\d{4}-\d{2}[a-z]?\.db$/;

/**
 * Build the absolute path to the archive directory for a given data_dir.
 * @param {string} dataDir
 * @returns {string}
 */
export function archiveDir(dataDir) {
  return path.join(dataDir, 'archive');
}

/**
 * Ensure the archive directory exists (idempotent).
 * @param {string} archDir
 */
export function ensureArchiveDir(archDir) {
  fs.mkdirSync(archDir, { recursive: true });
}

/**
 * Create a new archive bucket file with the v2 `events` schema mirrored
 * from the live tier, plus the `_meta` table. Returns the open Database
 * handle. Caller is responsible for closing it.
 *
 * @param {string} filepath - absolute path to the bucket .db file
 * @param {{ minEventId?: number, maxEventId?: number }} [meta]
 * @returns {import('better-sqlite3').Database}
 */
export function createBucket(filepath, meta = {}) {
  ensureArchiveDir(path.dirname(filepath));
  const Database = require('better-sqlite3');
  const db = new Database(filepath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id                 INTEGER PRIMARY KEY,
      event_type               TEXT    NOT NULL,
      domain                   TEXT    NOT NULL,
      subdomain                TEXT    NOT NULL DEFAULT '',
      payload                  TEXT    NOT NULL,
      schema_version           TEXT    NOT NULL DEFAULT '1.0.0',
      idempotency_key          TEXT    NOT NULL,
      emitted_at               INTEGER NOT NULL,
      expires_at               INTEGER NOT NULL,
      dedup_expires_at         INTEGER NOT NULL,
      metadata                 TEXT,
      parent_event_id          INTEGER,
      session_id               TEXT,
      correlation_id           TEXT,
      producer_id              TEXT,
      origin_node_id           TEXT,
      registry_schema_version  INTEGER,
      payload_cas_sha          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_event_type      ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_domain          ON events(domain);
    CREATE INDEX IF NOT EXISTS idx_events_correlation_id  ON events(correlation_id);

    CREATE TABLE IF NOT EXISTS _meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);

  setMeta(db, 'created_at', String(Date.now()));
  if (meta.minEventId != null) setMeta(db, 'min_event_id', String(meta.minEventId));
  if (meta.maxEventId != null) setMeta(db, 'max_event_id', String(meta.maxEventId));

  return db;
}

/**
 * Read the `_meta` key/value pairs from a bucket file.
 * Opens read-only so a sealed bucket can be inspected without taking a write lock.
 *
 * @param {string} filepath
 * @returns {Record<string,string>}
 */
export function getBucketMeta(filepath) {
  const Database = require('better-sqlite3');
  const db = new Database(filepath, { readonly: true });
  try {
    const rows = db.prepare('SELECT k, v FROM _meta').all();
    const meta = {};
    for (const r of rows) meta[r.k] = r.v;
    return meta;
  } finally {
    db.close();
  }
}

/**
 * Mark a bucket sealed: write `sealed_at` and (optionally) finalize `max_event_id`.
 * Once sealed, a bucket's covered range is fixed and the resolver can use
 * the [min, max] interval to skip it when out of range.
 *
 * @param {string} filepath
 * @param {{ maxEventId?: number }} [opts]
 */
export function sealBucket(filepath, opts = {}) {
  const Database = require('better-sqlite3');
  const db = new Database(filepath);
  try {
    setMeta(db, 'sealed_at', String(Date.now()));
    if (opts.maxEventId != null) {
      setMeta(db, 'max_event_id', String(opts.maxEventId));
    }
  } finally {
    db.close();
  }
}

function setMeta(db, k, v) {
  db.prepare('INSERT OR REPLACE INTO _meta(k, v) VALUES (?, ?)').run(k, v);
}

/**
 * List all bucket files in the archive directory, sorted lexicographically.
 * Suffix letters (`a`, `b`, …) preserve creation order within a month after
 * auto-split, so lexical sort matches creation order.
 *
 * @param {string} archDir
 * @returns {string[]} absolute paths
 */
export function listBuckets(archDir) {
  if (!fs.existsSync(archDir)) return [];
  return fs.readdirSync(archDir)
    .filter(f => BUCKET_FILE_RE.test(f))
    .sort()
    .map(f => path.join(archDir, f));
}

/**
 * Find buckets that cover (any part of) the event_id range [gapStart, gapEnd].
 * Returns descriptors with absolute path + parsed range + unsealed flag.
 * Unsealed buckets are conservatively included whenever their `min_event_id`
 * is at or below `gapEnd`.
 *
 * @param {string} archDir
 * @param {number} gapStart - inclusive
 * @param {number} gapEnd   - inclusive
 * @returns {Array<{ filepath: string, min: number, max: number, unsealed: boolean }>}
 */
export function bucketsCoveringRange(archDir, gapStart, gapEnd) {
  const all = listBuckets(archDir);
  const covering = [];
  for (const filepath of all) {
    let meta;
    try {
      meta = getBucketMeta(filepath);
    } catch (_e) {
      // Unreadable bucket — surface to caller via spill, not enumeration.
      // Caller's ATTACH attempt will throw WB-013 if needed.
      covering.push({ filepath, min: -Infinity, max: Infinity, unsealed: true });
      continue;
    }
    const min = meta.min_event_id != null ? Number(meta.min_event_id) : null;
    const sealed = meta.sealed_at != null;
    const max = sealed && meta.max_event_id != null
      ? Number(meta.max_event_id)
      : Number.MAX_SAFE_INTEGER;

    if (min === null) continue; // empty bucket — nothing to cover

    if (max >= gapStart && min <= gapEnd) {
      covering.push({ filepath, min, max, unsealed: !sealed });
    }
  }
  return covering;
}
