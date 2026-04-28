/**
 * Fault-injection matrix from DESIGN-v2.md §14.1 — concurrency & boundary
 * scenarios that the focused unit tests can't cover:
 *   T8   concurrent poll() + sweep — no gaps under interleaving
 *   T9   bucket unavailable during spill → WB-013, no cursor advance
 *   T10  ATTACH ceiling: query spans more than 125 buckets
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';
import {
  archiveDir,
  ensureArchiveDir,
  createBucket,
  sealBucket,
} from '../../lib/archive.js';
import { pollResolve } from '../../lib/query.js';
import { runSweepV2 } from '../../lib/sweep-v2.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mkEvent(eventId, overrides = {}) {
  return {
    event_id: eventId,
    event_type: 'wicked.test.fired',
    domain: 'd',
    subdomain: '',
    payload: JSON.stringify({ n: eventId }),
    schema_version: '1.0.0',
    idempotency_key: `evt-${eventId}-${randomUUID()}`,
    emitted_at: 1700000000000 + eventId,
    expires_at: 1700000000000 + eventId + 86400000,
    dedup_expires_at: 1,
    metadata: null,
    ...overrides,
  };
}

function insertLive(db, ev) {
  db.prepare(`
    INSERT INTO events
      (event_id, event_type, domain, subdomain, payload, schema_version,
       idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ev.event_id, ev.event_type, ev.domain, ev.subdomain,
    ev.payload, ev.schema_version, ev.idempotency_key,
    ev.emitted_at, ev.expires_at, ev.dedup_expires_at, ev.metadata,
  );
}

function insertWarm(bucketDb, ev) {
  bucketDb.prepare(`
    INSERT INTO events
      (event_id, event_type, domain, subdomain, payload, schema_version,
       idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ev.event_id, ev.event_type, ev.domain, ev.subdomain,
    ev.payload, ev.schema_version, ev.idempotency_key,
    ev.emitted_at, ev.expires_at, ev.dedup_expires_at, ev.metadata,
  );
}

function buildBucket(archDir, name, minId, maxId) {
  const filepath = join(archDir, name);
  const db = createBucket(filepath, { minEventId: minId, maxEventId: maxId });
  for (let i = minId; i <= maxId; i++) insertWarm(db, mkEvent(i));
  db.close();
  sealBucket(filepath, { maxEventId: maxId });
  return filepath;
}

// ---------------------------------------------------------------------------

describe('§14.1 fault-injection matrix — concurrency & boundary', () => {
  let tmpDir;
  let archDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-fault-' + randomUUID());
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

  // -------------------------------------------------------------------------
  // T8 — Concurrent poll + sweep
  //   Repeatedly emit + sweep + poll under interleaving and assert that
  //   every event is observed exactly once and in order.
  // -------------------------------------------------------------------------

  it('T8: concurrent poll + sweep — no gaps, ascending order, full coverage', () => {
    // Pre-populate live with 200 TTL'd events.
    for (let i = 1; i <= 200; i++) insertLive(db, mkEvent(i));

    // Cursor walk: poll → sweep partial → poll → sweep again, repeating until
    // we've collected all 200. Each iteration uses a small batch size to
    // force many transitions through the cross-tier boundary.
    const collected = [];
    let cursor = 0;
    let safety = 0;

    while (collected.length < 200 && safety++ < 50) {
      // Step the sweep forward by a few rows
      runSweepV2(db, { data_dir: tmpDir, sweep_batch_size: 25 });

      // Poll and append. This call exercises the spill path whenever the
      // sweep has just moved rows past the cursor.
      const batch = pollResolve(db, archDir, { lastEventId: cursor, batchSize: 30 });
      for (const ev of batch) collected.push(ev.event_id);
      if (batch.length > 0) cursor = batch[batch.length - 1].event_id;
      else if (collected.length >= 200) break;
    }

    expect(collected).toHaveLength(200);
    for (let i = 0; i < collected.length; i++) {
      expect(collected[i]).toBe(i + 1);                                 // strict 1..200
    }
  });

  // -------------------------------------------------------------------------
  // T9 — Bucket unavailable during spill → WB-013, cursor unchanged
  // -------------------------------------------------------------------------

  // T9 relies on `fs.chmodSync(file, 0o000)` to make a bucket unreadable.
  // Windows does not honor POSIX file-mode bits — the chmod is a no-op there.
  // The library-level guarantee (WB-013 on a locked/missing bucket) is
  // already covered by `lib/query.js readBucket` and exercised on POSIX.
  const it_t9 = (typeof process !== 'undefined' && process.platform === 'win32') ? it.skip : it;
  it_t9('T9: locked bucket during spill → WB-013, no cursor advance', () => {
    buildBucket(archDir, 'bus-2026-01.db', 1, 50);

    // Make the bucket unreadable by stripping perms (POSIX). On Windows we
    // can also rename the file out of the way; the spill will fail with
    // ENOENT and produce the same WB-013.
    const filepath = join(archDir, 'bus-2026-01.db');
    fs.chmodSync(filepath, 0o000);

    try {
      let caught = null;
      try {
        pollResolve(db, archDir, { lastEventId: 0, batchSize: 100 });
      } catch (e) { caught = e; }

      expect(caught).not.toBeNull();
      expect(caught.error).toBe('WB-013');
      expect(caught.code).toBe('SPILL_BUCKET_UNAVAILABLE');
      // The cursor input wasn't an external state, but the resolver MUST
      // throw rather than silently return [] — that's the durability
      // guarantee §5.4 promises.
    } finally {
      try { fs.chmodSync(filepath, 0o600); } catch (_e) { /* ignore */ }
    }
  });

  // -------------------------------------------------------------------------
  // T10 — ATTACH ceiling: many warm buckets in a single spill
  // -------------------------------------------------------------------------

  // T10 builds 130 sealed SQLite buckets in a row. Windows file-creation
  // latency (NTFS + AV scan) is several × macOS/Linux, so the default 15s
  // vitest timeout isn't enough. Give it 60s — the library work is identical
  // across platforms; only the test setup is slower.
  it('T10: spill spanning > ATTACH ceiling buckets — first ceiling is processed cleanly', { timeout: 60_000 }, () => {
    // Build 130 buckets, each with 1 event (event_ids 1..130). The resolver's
    // ATTACH cap is 123; it should attach the first 123, return up to
    // batchSize results in order, and never silently drop events under the
    // cap. The remaining 7 events are reachable on the next poll once the
    // cursor advances past the first batch.
    for (let i = 1; i <= 130; i++) {
      // Distinct file names within the lex-ordered range. Use 2-digit suffix
      // so lex sort matches numeric event-id order: 'aa', 'ab', 'ac' would
      // exceed the spec's single-letter range; instead, use a different
      // month per bucket.
      const month = String(((i - 1) % 12) + 1).padStart(2, '0');
      const year = 2020 + Math.floor((i - 1) / 12);
      const name = `bus-${year}-${month}.db`;
      // Avoid collisions: each bucket gets exactly one event_id mapped from
      // the loop index, but distinct files require distinct (year, month).
      // For values past month 12 of a year, the loop already stepped year up.
      buildBucket(archDir, name, i, i);
    }

    const rows = pollResolve(db, archDir, { lastEventId: 0, batchSize: 50 });

    // We only asserted batchSize=50 results; the resolver should return
    // strictly ascending event_ids, no duplicates, no gaps within what's
    // returned, and the count should be exactly 50 (since 50 of the 130
    // events fit and no early termination is expected before then).
    expect(rows.length).toBe(50);
    const ids = rows.map(r => r.event_id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });
});
