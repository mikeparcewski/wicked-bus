/**
 * CAS tests — put/get/exists/stats round-trip + GC including the
 * offline-bucket-safety rule (WB-010).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';
import {
  put, get, exists, stats, gc, casDir,
} from '../../lib/cas.js';
import {
  archiveDir,
  ensureArchiveDir,
  createBucket,
  sealBucket,
} from '../../lib/archive.js';

const requireCJS = createRequire(import.meta.url);

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------

describe('cas — put / get / exists / stats', () => {
  let tmpDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-cas-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    db = openDb();
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* ignore */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  it('put returns the SHA-256 of the content', () => {
    const sha = put(tmpDir, 'hello world');
    expect(sha).toBe(sha256Hex('hello world'));
  });

  it('get returns the original Buffer; null for unknown SHA', () => {
    const sha = put(tmpDir, Buffer.from([1, 2, 3, 4]));
    const buf = get(tmpDir, sha);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
    expect(get(tmpDir, '0'.repeat(64))).toBeNull();
  });

  it('exists reports presence', () => {
    const sha = put(tmpDir, 'present');
    expect(exists(tmpDir, sha)).toBe(true);
    expect(exists(tmpDir, '0'.repeat(64))).toBe(false);
  });

  it('put is idempotent for identical content (no-op on second write)', () => {
    const sha1 = put(tmpDir, 'same content');
    const filePath = join(casDir(tmpDir), sha1.slice(0, 2), sha1);
    const mtime1 = fs.statSync(filePath).mtimeMs;
    const sha2 = put(tmpDir, 'same content');
    expect(sha2).toBe(sha1);
    const mtime2 = fs.statSync(filePath).mtimeMs;
    expect(mtime2).toBe(mtime1);                    // no rewrite
  });

  it('shards by leading 2 hex chars of SHA', () => {
    const sha = put(tmpDir, 'shard test');
    const shard = sha.slice(0, 2);
    const target = join(casDir(tmpDir), shard, sha);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('rejects content larger than the configured cap with WB-008', () => {
    const big = Buffer.alloc(2048);
    expect(() => put(tmpDir, big, { max_bytes: 1024 }))
      .toThrow(expect.objectContaining({ error: 'WB-008' }));
  });

  it('rejects non-Buffer/non-string content with WB-001', () => {
    expect(() => put(tmpDir, { not: 'a-buffer' }))
      .toThrow(expect.objectContaining({ error: 'WB-001' }));
  });

  it('stats reports object_count and total_bytes accurately', () => {
    expect(stats(tmpDir)).toEqual({
      root: casDir(tmpDir), object_count: 0, total_bytes: 0,
    });

    put(tmpDir, 'aaa');
    put(tmpDir, 'bbb');
    put(tmpDir, 'ccc');

    const s = stats(tmpDir);
    expect(s.object_count).toBe(3);
    expect(s.total_bytes).toBe(9);
  });
});

// ---------------------------------------------------------------------------

describe('cas — gc', () => {
  let tmpDir;
  let archDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-cas-gc-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    archDir = archiveDir(tmpDir);
    ensureArchiveDir(archDir);
    db = openDb();
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* ignore */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // Build an event row referencing a CAS sha. Live-tier insert.
  function insertLiveWithCas(sha) {
    db.prepare(`
      INSERT INTO events (
        event_id, event_type, domain, subdomain, payload, schema_version,
        idempotency_key, emitted_at, expires_at, dedup_expires_at,
        payload_cas_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sha === null ? null : sha.length,                  // dummy event_id (1+)
      'wicked.test.fired', 'd', '',
      '{"$cas":"' + (sha || '') + '"}',
      '1.0.0',
      randomUUID(),
      Date.now(), Date.now() + 86400000, Date.now() + 86400000,
      sha,
    );
  }

  function insertWarmWithCas(bucketName, eventId, sha) {
    const filepath = join(archDir, bucketName);
    const bucketDb = fs.existsSync(filepath)
      ? requireCJS('better-sqlite3')(filepath)
      : createBucket(filepath, { minEventId: eventId, maxEventId: eventId });
    try {
      bucketDb.prepare(`
        INSERT INTO events (
          event_id, event_type, domain, subdomain, payload, schema_version,
          idempotency_key, emitted_at, expires_at, dedup_expires_at,
          payload_cas_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId, 'wicked.test.fired', 'd', '',
        '{"$cas":"' + sha + '"}', '1.0.0', randomUUID(),
        Date.now(), Date.now() + 86400000, Date.now() + 86400000,
        sha,
      );
    } finally {
      bucketDb.close();
    }
    sealBucket(filepath, { maxEventId: eventId });
  }

  it('keeps SHAs referenced by live events', () => {
    const sha = put(tmpDir, 'kept-by-live');
    insertLiveWithCas(sha);

    // Force file mtime to be old enough that grace window doesn't save it
    const filePath = join(casDir(tmpDir), sha.slice(0, 2), sha);
    const old = Date.now() - 100 * 86400_000;
    fs.utimesSync(filePath, old / 1000, old / 1000);

    const result = gc({ dataDir: tmpDir, liveDb: db });

    expect(result.live_shas).toBe(1);
    expect(result.deleted).toBe(0);
    expect(exists(tmpDir, sha)).toBe(true);
  });

  it('keeps SHAs referenced by warm buckets', () => {
    const liveSha = put(tmpDir, 'live-only');
    const warmSha = put(tmpDir, 'warm-only');
    insertLiveWithCas(liveSha);
    insertWarmWithCas('bus-2026-04.db', 1, warmSha);

    // Both files are old (skip grace window)
    const old = Date.now() - 100 * 86400_000;
    for (const sha of [liveSha, warmSha]) {
      const fp = join(casDir(tmpDir), sha.slice(0, 2), sha);
      fs.utimesSync(fp, old / 1000, old / 1000);
    }

    const result = gc({ dataDir: tmpDir, liveDb: db });

    expect(result.live_shas).toBe(2);
    expect(result.deleted).toBe(0);
    expect(exists(tmpDir, liveSha)).toBe(true);
    expect(exists(tmpDir, warmSha)).toBe(true);
  });

  it('deletes orphans whose mtime is past the grace window', () => {
    const refSha   = put(tmpDir, 'referenced');
    const orphSha  = put(tmpDir, 'orphan');
    insertLiveWithCas(refSha);

    // Age both files past grace
    const old = Date.now() - 100 * 86400_000;
    for (const sha of [refSha, orphSha]) {
      const fp = join(casDir(tmpDir), sha.slice(0, 2), sha);
      fs.utimesSync(fp, old / 1000, old / 1000);
    }

    const result = gc({ dataDir: tmpDir, liveDb: db });

    expect(result.live_shas).toBe(1);
    expect(result.deleted).toBe(1);
    expect(exists(tmpDir, refSha)).toBe(true);
    expect(exists(tmpDir, orphSha)).toBe(false);
  });

  it('respects the grace window for recently-modified orphans', () => {
    const orphSha = put(tmpDir, 'fresh-orphan');
    // Default grace = 7 days; file was just written so it's well within grace.

    const result = gc({ dataDir: tmpDir, liveDb: db });

    expect(result.live_shas).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.skipped_in_grace).toBe(1);
    expect(exists(tmpDir, orphSha)).toBe(true);
  });

  it('dry_run does not delete, but reports what would be deleted', () => {
    const orphSha = put(tmpDir, 'would-delete');
    const old = Date.now() - 100 * 86400_000;
    fs.utimesSync(join(casDir(tmpDir), orphSha.slice(0, 2), orphSha), old / 1000, old / 1000);

    const result = gc({ dataDir: tmpDir, liveDb: db, dry_run: true });

    expect(result.deleted).toBe(1);
    expect(exists(tmpDir, orphSha)).toBe(true);            // still present
  });

  // -------------------------------------------------------------------------
  // Offline-bucket safety (WB-010, round-1 council fix)
  // -------------------------------------------------------------------------

  skipOnWindows('aborts with WB-010 when a warm bucket is unreadable', () => {
    const sha = put(tmpDir, 'hash-here');
    insertLiveWithCas(sha);

    // Create a bucket file then strip read perms
    const filepath = join(archDir, 'bus-2026-04.db');
    const bucketDb = createBucket(filepath, { minEventId: 1, maxEventId: 1 });
    bucketDb.close();
    sealBucket(filepath, { maxEventId: 1 });
    fs.chmodSync(filepath, 0o000);                          // unreadable

    try {
      expect(() => gc({ dataDir: tmpDir, liveDb: db }))
        .toThrow(expect.objectContaining({ error: 'WB-010' }));
    } finally {
      // Restore so afterEach cleanup can succeed
      try { fs.chmodSync(filepath, 0o600); } catch (_e) { /* ignore */ }
    }
  });

  skipOnWindows('allow_missing_buckets lets the operator acknowledge intentional absences', () => {
    const sha = put(tmpDir, 'still-here');
    insertLiveWithCas(sha);

    const filepath = join(archDir, 'bus-2026-04.db');
    const bucketDb = createBucket(filepath, { minEventId: 1, maxEventId: 1 });
    bucketDb.close();
    sealBucket(filepath, { maxEventId: 1 });
    fs.chmodSync(filepath, 0o000);

    try {
      const result = gc({
        dataDir: tmpDir,
        liveDb: db,
        allow_missing_buckets: ['bus-2026-04.db'],
      });
      expect(result.live_shas).toBe(1);                     // only live shas counted
    } finally {
      try { fs.chmodSync(filepath, 0o600); } catch (_e) { /* ignore */ }
    }
  });

  it('rejects calls without dataDir or liveDb', () => {
    expect(() => gc({ liveDb: db })).toThrow();
    expect(() => gc({ dataDir: tmpDir })).toThrow();
  });
});

