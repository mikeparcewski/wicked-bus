/**
 * Content-addressable store (CAS) for large event payloads.
 *
 * Per DESIGN-v2.md §6:
 *   - Storage: `<dataDir>/cas/<sha[0:2]>/<sha>` (200-bit sharding)
 *   - SHA-256 of uncompressed content; filename is full hex SHA
 *   - O_EXCL writes; collision = no-op (immutable, content-addressed)
 *   - Object size cap (default 256 MB) — `WB-008 PAYLOAD_TOO_LARGE` above
 *   - Reference-tracked via `events.payload_cas_sha`; GC walks live + warm
 *     buckets and deletes orphans past a configurable grace window
 *   - GC aborts with `WB-010 CAS_GC_INCOMPLETE_BUCKET_SET` if any bucket is
 *     unreadable (offline-bucket safety, round-1 council fix)
 *
 * The functions are synchronous because better-sqlite3 is synchronous and
 * fs.* sync APIs are fine for the CAS sizes we target (≤256 MB by default).
 *
 * @module lib/cas
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { WBError } from './errors.js';
import { archiveDir, listBuckets } from './archive.js';

const require = createRequire(import.meta.url);

export const DEFAULT_OBJECT_MAX_BYTES   = 256 * 1024 * 1024;
export const DEFAULT_GC_GRACE_DAYS      = 7;

/**
 * Standard CAS root for a given dataDir.
 * @param {string} dataDir
 * @returns {string}
 */
export function casDir(dataDir) {
  return path.join(dataDir, 'cas');
}

function shardedPathFor(dataDir, sha) {
  return path.join(casDir(dataDir), sha.slice(0, 2), sha);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function ensureBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
    message: 'cas.put requires Buffer or string content',
    received: typeof content,
  });
}

// ---------------------------------------------------------------------------
// put / get / exists / stats
// ---------------------------------------------------------------------------

/**
 * Store content in the CAS. Returns the SHA-256 hex digest.
 * Writes are O_EXCL — duplicate content (same SHA) is a no-op.
 *
 * @param {string} dataDir
 * @param {Buffer|string} content
 * @param {object} [opts]
 * @param {number} [opts.max_bytes]   override DEFAULT_OBJECT_MAX_BYTES
 * @returns {string}                  SHA-256 hex digest
 */
export function put(dataDir, content, opts = {}) {
  const buf = ensureBuffer(content);
  const cap = opts.max_bytes ?? DEFAULT_OBJECT_MAX_BYTES;

  if (buf.length > cap) {
    throw new WBError('WB-008', 'PAYLOAD_TOO_LARGE', {
      message: `CAS object exceeds ${cap}-byte cap`,
      size: buf.length,
      cap,
    });
  }

  const sha = sha256(buf);
  const target = shardedPathFor(dataDir, sha);

  if (fs.existsSync(target)) return sha;   // immutable; collision = no-op

  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Write to a temp file in the same directory then rename; this gives us
  // atomic visibility and avoids partial reads during a crash.
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  }

  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // Race: another writer just moved their copy into place. Same SHA →
    // identical content → safe to drop ours.
    try { fs.unlinkSync(tmp); } catch (_e) { /* ignore */ }
    if (e.code !== 'EEXIST') throw e;
  }

  return sha;
}

/**
 * Read content for a given SHA. Returns a Buffer, or null if not found.
 */
export function get(dataDir, sha) {
  const target = shardedPathFor(dataDir, sha);
  try {
    return fs.readFileSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function exists(dataDir, sha) {
  return fs.existsSync(shardedPathFor(dataDir, sha));
}

/**
 * Aggregate stats: total objects, total bytes, root path.
 */
export function stats(dataDir) {
  const root = casDir(dataDir);
  if (!fs.existsSync(root)) {
    return { root, object_count: 0, total_bytes: 0 };
  }

  let count = 0;
  let bytes = 0;
  for (const file of walkCasFiles(root)) {
    count++;
    try { bytes += fs.statSync(file).size; }
    catch (_e) { /* removed concurrently */ }
  }
  return { root, object_count: count, total_bytes: bytes };
}

function* walkCasFiles(root) {
  for (const shard of safeReaddir(root)) {
    const shardDir = path.join(root, shard);
    let stat;
    try { stat = fs.statSync(shardDir); }
    catch (_e) { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of safeReaddir(shardDir)) {
      yield path.join(shardDir, f);
    }
  }
}

function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch (_e) { return []; }
}

// ---------------------------------------------------------------------------
// GC — offline-bucket-safe (round-1 council fix)
// ---------------------------------------------------------------------------

/**
 * Walk the live tier and all warm buckets to compute the live SHA set, then
 * remove CAS entries that are NOT referenced and were last modified before
 * `now - graceMs`. ABORTS with WB-010 if any bucket is unreadable so we
 * never silently shrink the live set on incomplete data.
 *
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {import('better-sqlite3').Database} opts.liveDb
 * @param {number} [opts.grace_days]
 * @param {number} [opts.now]                              test-injectable timestamp
 * @param {string[]} [opts.allow_missing_buckets]          basenames (or globs) the
 *                                                         operator has agreed are
 *                                                         intentionally absent (e.g.,
 *                                                         exported to cold and removed)
 * @param {boolean} [opts.dry_run=false]
 * @returns {{
 *   live_shas: number,
 *   considered: number,
 *   deleted: number,
 *   skipped_in_grace: number,
 *   bytes_freed: number,
 * }}
 */
export function gc(opts) {
  const dataDir   = opts.dataDir;
  const liveDb    = opts.liveDb;
  const graceDays = opts.grace_days ?? DEFAULT_GC_GRACE_DAYS;
  const graceMs   = graceDays * 86400_000;
  const now       = opts.now ?? Date.now();
  const allow     = new Set(opts.allow_missing_buckets ?? []);
  const dryRun    = !!opts.dry_run;

  if (!dataDir) throw new Error('gc requires opts.dataDir');
  if (!liveDb)  throw new Error('gc requires opts.liveDb');

  const liveShas = collectLiveShasOrAbort(dataDir, liveDb, allow);

  const root = casDir(dataDir);
  if (!fs.existsSync(root)) {
    return { live_shas: liveShas.size, considered: 0, deleted: 0, skipped_in_grace: 0, bytes_freed: 0 };
  }

  let considered = 0;
  let deleted = 0;
  let skippedInGrace = 0;
  let bytesFreed = 0;

  for (const file of walkCasFiles(root)) {
    considered++;
    const sha = path.basename(file);
    if (liveShas.has(sha)) continue;

    let stat;
    try { stat = fs.statSync(file); }
    catch (_e) { continue; }                         // removed concurrently

    if (now - stat.mtimeMs < graceMs) {
      skippedInGrace++;
      continue;
    }

    if (!dryRun) {
      try {
        fs.unlinkSync(file);
        deleted++;
        bytesFreed += stat.size;
      } catch (_e) { /* concurrent delete or permission — skip */ }
    } else {
      deleted++;
      bytesFreed += stat.size;
    }
  }

  return {
    live_shas: liveShas.size,
    considered,
    deleted,
    skipped_in_grace: skippedInGrace,
    bytes_freed: bytesFreed,
  };
}

/**
 * Build the set of payload_cas_sha values referenced by ANY event in live or
 * any warm bucket. Aborts with WB-010 if any bucket is unreadable.
 */
function collectLiveShasOrAbort(dataDir, liveDb, allowSet) {
  const shas = new Set();

  // Live tier
  for (const row of liveDb.prepare(
    'SELECT payload_cas_sha FROM events WHERE payload_cas_sha IS NOT NULL'
  ).all()) {
    if (row.payload_cas_sha) shas.add(row.payload_cas_sha);
  }

  // Warm tier — every expected bucket must be readable
  const archDir = archiveDir(dataDir);
  for (const filepath of listBuckets(archDir)) {
    const basename = path.basename(filepath);
    if (allowSet.has(basename)) continue;            // operator-acknowledged absence

    try { fs.accessSync(filepath, fs.constants.R_OK); }
    catch (e) {
      throw new WBError('WB-010', 'CAS_GC_INCOMPLETE_BUCKET_SET', {
        message: `CAS GC requires every warm bucket to be readable; ${basename} is not`,
        bucket: filepath,
        cause: e.code,
      });
    }

    let bucketDb;
    try {
      const Database = require('better-sqlite3');
      bucketDb = new Database(filepath, { readonly: true });
    } catch (e) {
      throw new WBError('WB-010', 'CAS_GC_INCOMPLETE_BUCKET_SET', {
        message: `failed to open warm bucket: ${basename}`,
        bucket: filepath,
        cause: e.message,
      });
    }

    try {
      for (const row of bucketDb.prepare(
        'SELECT payload_cas_sha FROM events WHERE payload_cas_sha IS NOT NULL'
      ).all()) {
        if (row.payload_cas_sha) shas.add(row.payload_cas_sha);
      }
    } finally {
      bucketDb.close();
    }
  }

  return shas;
}
