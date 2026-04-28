/**
 * §14.3 I7 — CAS GC offline-bucket abort end-to-end.
 *
 * This integration test exercises the full lifecycle:
 *   1. cas-auto schema → emit() puts payload in CAS, live row stores {$cas:sha}
 *   2. Sweep moves the live row to warm — payload_cas_sha follows
 *   3. With the warm bucket present, GC sees the SHA as referenced
 *   4. Strip the warm bucket's read perms → GC must abort with WB-010
 *   5. With `allow_missing_buckets`, GC proceeds and counts only live SHAs
 *
 * This is the integration version of `tests/unit/cas.test.js` "aborts with
 * WB-010 when a warm bucket is unreadable" — instead of building the bucket
 * by hand, we go through the real emit + sweep path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { runSweepV2 } from '../../lib/sweep-v2.js';
import { archiveDir, listBuckets } from '../../lib/archive.js';
import { gc as casGc, exists as casExists } from '../../lib/cas.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

describe('§14.3 I7 — CAS GC end-to-end with offline-bucket abort', () => {
  let tmpDir;
  let archDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-i7-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    archDir = archiveDir(tmpDir);
    db = openDb();

    // Register a cas-auto schema with a tiny cap.
    db.prepare(`
      INSERT INTO schemas (
        event_type, version, json_schema, retention,
        payload_max_bytes, archive_to, payload_oversize
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'wicked.test.fired', 1, JSON.stringify({ type: 'object' }),
      'default', 32, 'warm', 'cas-auto',
    );
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* ignore */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  skipOnWindows('full lifecycle — emit→cas-auto→sweep→GC keeps SHAs reachable from warm; abort on unreadable bucket', () => {
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    const big = JSON.stringify({ data: 'y'.repeat(200) });

    // 1. Emit triggers cas-auto offload — payload lands in CAS, live row
    //    stores {$cas:sha} + payload_cas_sha column.
    const r = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: JSON.parse(big),
    });
    const liveRow = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(liveRow.payload_cas_sha).toMatch(/^[0-9a-f]{64}$/);
    const sha = liveRow.payload_cas_sha;

    // 2. Sweep moves the live row to a warm bucket. payload_cas_sha follows.
    runSweepV2(db, { data_dir: tmpDir, now: Date.now() + 86400000 * 365 });
    const liveCount = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    expect(liveCount).toBe(0);

    const buckets = listBuckets(archDir);
    expect(buckets.length).toBe(1);

    // 3. With the bucket readable, GC counts the SHA as live and keeps it.
    //    Force file mtime past the grace window.
    const casFile = join(tmpDir, 'cas', sha.slice(0, 2), sha);
    const old = (Date.now() - 100 * 86400_000) / 1000;
    fs.utimesSync(casFile, old, old);

    const ok = casGc({ dataDir: tmpDir, liveDb: db });
    expect(ok.live_shas).toBe(1);
    expect(ok.deleted).toBe(0);
    expect(casExists(tmpDir, sha)).toBe(true);

    // 4. Strip the bucket's read perms → GC must abort with WB-010 rather
    //    than silently undercount and delete the SHA.
    const bucketPath = buckets[0];
    fs.chmodSync(bucketPath, 0o000);
    try {
      let caught = null;
      try { casGc({ dataDir: tmpDir, liveDb: db }); }
      catch (e) { caught = e; }

      expect(caught).not.toBeNull();
      expect(caught.error).toBe('WB-010');
      expect(caught.code).toBe('CAS_GC_INCOMPLETE_BUCKET_SET');
      // CRITICAL: even after the abort, the CAS object must still be present.
      expect(casExists(tmpDir, sha)).toBe(true);
    } finally {
      try { fs.chmodSync(bucketPath, 0o600); } catch (_e) { /* ignore */ }
    }

    // 5. With `allow_missing_buckets`, GC proceeds. Live tier has been
    //    drained, so the SHA is no longer referenced by the (operator-
    //    acknowledged) reduced set, and would be deleted if past grace.
    fs.chmodSync(bucketPath, 0o000);
    try {
      const partial = casGc({
        dataDir: tmpDir,
        liveDb: db,
        allow_missing_buckets: [bucketPath.split('/').pop()],
      });
      expect(partial.live_shas).toBe(0);                // live drained, bucket excluded
      expect(partial.deleted).toBe(1);                  // sha now an orphan
      expect(casExists(tmpDir, sha)).toBe(false);
    } finally {
      try { fs.chmodSync(bucketPath, 0o600); } catch (_e) { /* ignore */ }
    }
  });
});
