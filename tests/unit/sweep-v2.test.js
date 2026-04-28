/**
 * v2 tiered sweep tests — DESIGN-v2.md §14.1 fault-injection scenarios
 * for the sweep mechanism: T6 (WAL checkpoint), T11 (batch boundary),
 * T12 (auto-split coordination), plus core correctness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';
import { archiveDir, listBuckets, getBucketMeta } from '../../lib/archive.js';
import {
  runSweepV2,
  lockBucketForTesting,
  unlockBucketForTesting,
} from '../../lib/sweep-v2.js';
import { pollResolve } from '../../lib/query.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tsForMonth(year, month, dayOffset = 0) {
  return Date.UTC(year, month - 1, 1 + dayOffset);
}

function insertEvent(db, eventId, opts = {}) {
  const emittedAt = opts.emitted_at ?? Date.now();
  // Default dedup_expires_at is far in the past so events are sweep-eligible
  // regardless of how `emitted_at` relates to Date.now() (the system clock
  // can be ahead of or behind a synthetic test month).
  const dedupExpires = opts.dedup_expires_at ?? 1;
  db.prepare(`
    INSERT INTO events
      (event_id, event_type, domain, subdomain, payload, schema_version,
       idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    opts.event_type ?? 'wicked.test.fired',
    opts.domain ?? 'test',
    opts.subdomain ?? '',
    opts.payload ?? JSON.stringify({ n: eventId }),
    '1.0.0',
    `evt-${eventId}-${randomUUID()}`,
    emittedAt,
    emittedAt + 86400000,
    dedupExpires,
    null,
  );
}

function liveCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
}

// ---------------------------------------------------------------------------

describe('v2 tiered sweep (lib/sweep-v2.js)', () => {
  let tmpDir;
  let archDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-sweepv2-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    archDir = archiveDir(tmpDir);
    db = openDb();
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* already closed */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Core correctness
  // -------------------------------------------------------------------------

  it('moves TTL\'d events from live to a monthly warm bucket', () => {
    const apr = tsForMonth(2026, 4);
    for (let i = 1; i <= 10; i++) insertEvent(db, i, { emitted_at: apr + i });

    const result = runSweepV2(db, { data_dir: tmpDir });

    expect(result.events_moved).toBe(10);
    expect(result.buckets_touched).toEqual(['bus-2026-04.db']);
    expect(liveCount(db)).toBe(0);

    const buckets = listBuckets(archDir);
    expect(buckets.length).toBe(1);
    const meta = getBucketMeta(buckets[0]);
    expect(Number(meta.min_event_id)).toBe(1);
    expect(Number(meta.max_event_id)).toBe(10);
  });

  it('groups events into per-month buckets within a single batch', () => {
    insertEvent(db, 1, { emitted_at: tsForMonth(2026, 4) });
    insertEvent(db, 2, { emitted_at: tsForMonth(2026, 4, 5) });
    insertEvent(db, 3, { emitted_at: tsForMonth(2026, 5) });
    insertEvent(db, 4, { emitted_at: tsForMonth(2026, 5, 10) });
    insertEvent(db, 5, { emitted_at: tsForMonth(2026, 6) });

    const result = runSweepV2(db, { data_dir: tmpDir });

    expect(result.events_moved).toBe(5);
    expect(result.buckets_touched.sort()).toEqual([
      'bus-2026-04.db', 'bus-2026-05.db', 'bus-2026-06.db',
    ]);
    expect(liveCount(db)).toBe(0);
  });

  it('does not move events whose dedup_expires_at is still in the future', () => {
    const future = Date.now() + 1_000_000;
    insertEvent(db, 1, { dedup_expires_at: future });
    insertEvent(db, 2, { dedup_expires_at: future });

    const result = runSweepV2(db, { data_dir: tmpDir });

    expect(result.events_moved).toBe(0);
    expect(liveCount(db)).toBe(2);
    expect(listBuckets(archDir).length).toBe(0);
  });

  it('is idempotent — re-running with no new candidates is a no-op', () => {
    insertEvent(db, 1, { emitted_at: tsForMonth(2026, 4) });
    runSweepV2(db, { data_dir: tmpDir });

    const result = runSweepV2(db, { data_dir: tmpDir });

    expect(result.events_moved).toBe(0);
    expect(result.buckets_touched).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // T11 — Backpressure batch boundary
  // -------------------------------------------------------------------------

  it('T11: respects sweep_batch_size, leaving overflow for the next batch', () => {
    const apr = tsForMonth(2026, 4);
    for (let i = 1; i <= 25; i++) insertEvent(db, i, { emitted_at: apr + i });

    const r1 = runSweepV2(db, { data_dir: tmpDir, sweep_batch_size: 10 });
    expect(r1.events_moved).toBe(10);
    expect(liveCount(db)).toBe(15);

    const r2 = runSweepV2(db, { data_dir: tmpDir, sweep_batch_size: 10 });
    expect(r2.events_moved).toBe(10);
    expect(liveCount(db)).toBe(5);

    const r3 = runSweepV2(db, { data_dir: tmpDir, sweep_batch_size: 10 });
    expect(r3.events_moved).toBe(5);
    expect(liveCount(db)).toBe(0);

    // All 25 must be in the bucket exactly once
    const meta = getBucketMeta(join(archDir, 'bus-2026-04.db'));
    expect(Number(meta.min_event_id)).toBe(1);
    expect(Number(meta.max_event_id)).toBe(25);
  });

  // -------------------------------------------------------------------------
  // T12 — Auto-split when bucket exceeds size threshold
  // -------------------------------------------------------------------------

  it('T12: rotates to a suffixed bucket when the current bucket exceeds size threshold', () => {
    const apr = tsForMonth(2026, 4);

    // First batch: 5 events into bus-2026-04.db
    for (let i = 1; i <= 5; i++) insertEvent(db, i, { emitted_at: apr + i });
    runSweepV2(db, { data_dir: tmpDir });

    // Force an aggressive split threshold: 1 byte. Next batch must rotate.
    for (let i = 6; i <= 10; i++) insertEvent(db, i, { emitted_at: apr + i });
    const r2 = runSweepV2(db, {
      data_dir: tmpDir,
      bucket_max_bytes: 1,
    });

    expect(r2.events_moved).toBe(5);
    expect(r2.buckets_touched).toEqual(['bus-2026-04a.db']);

    const buckets = listBuckets(archDir).map(p => p.split('/').pop());
    expect(buckets).toContain('bus-2026-04.db');
    expect(buckets).toContain('bus-2026-04a.db');

    // First bucket should now be sealed (sealed_at set when we rotated past it)
    const firstMeta = getBucketMeta(join(archDir, 'bus-2026-04.db'));
    expect(firstMeta.sealed_at).toBeDefined();

    // Second bucket holds 6-10
    const secondMeta = getBucketMeta(join(archDir, 'bus-2026-04a.db'));
    expect(Number(secondMeta.min_event_id)).toBe(6);
    expect(Number(secondMeta.max_event_id)).toBe(10);
  });

  // -------------------------------------------------------------------------
  // T6 — WAL checkpoint policy (PASSIVE → escalation)
  // -------------------------------------------------------------------------

  it('T6: returns a wal_checkpoint result of mode PASSIVE on a clean batch', () => {
    insertEvent(db, 1, { emitted_at: tsForMonth(2026, 4) });
    const result = runSweepV2(db, { data_dir: tmpDir });

    expect(result.wal_checkpoint).toBeDefined();
    expect(result.wal_checkpoint.mode).toBe('PASSIVE');
    expect(result.wal_checkpoint.busy_runs).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Lock coordination (sweep skips locked buckets)
  // -------------------------------------------------------------------------

  it('skips locked buckets and processes them on a later sweep', () => {
    insertEvent(db, 1, { emitted_at: tsForMonth(2026, 4) });
    insertEvent(db, 2, { emitted_at: tsForMonth(2026, 5) });

    lockBucketForTesting(archDir, 'bus-2026-04.db');
    const r1 = runSweepV2(db, { data_dir: tmpDir });

    expect(r1.events_moved).toBe(1);                                 // only May moved
    expect(r1.buckets_touched).toEqual(['bus-2026-05.db']);
    expect(r1.buckets_skipped_locked).toEqual(['bus-2026-04.db']);
    expect(liveCount(db)).toBe(1);                                   // April left in live

    unlockBucketForTesting(archDir, 'bus-2026-04.db');
    const r2 = runSweepV2(db, { data_dir: tmpDir });
    expect(r2.events_moved).toBe(1);
    expect(r2.buckets_touched).toEqual(['bus-2026-04.db']);
    expect(liveCount(db)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Cross-tier resolution invariant — sweep + warm-spill round-trip
  // -------------------------------------------------------------------------

  it('warm-spill resolver returns events in order after sweep moves them', () => {
    const apr = tsForMonth(2026, 4);
    for (let i = 1; i <= 50; i++) insertEvent(db, i, { emitted_at: apr + i });

    runSweepV2(db, { data_dir: tmpDir });
    expect(liveCount(db)).toBe(0);

    // Cursor at 0 — must spill into warm and return all 50 in order
    const rows = pollResolve(db, archDir, { lastEventId: 0, batchSize: 100 });

    expect(rows.length).toBe(50);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].event_id).toBe(i + 1);
    }
  });

  // -------------------------------------------------------------------------
  // Crash-window safety: simulate a crash between warm-COMMIT and live-DELETE
  // by manually re-inserting moved rows into live (live is the only source of
  // duplicates; warm INSERT-COMMIT happened first per invariant).
  // -------------------------------------------------------------------------

  it('crash-window: dedupe yields each event_id once when warm + live both have rows', () => {
    const apr = tsForMonth(2026, 4);
    for (let i = 1; i <= 5; i++) insertEvent(db, i, { emitted_at: apr + i });

    runSweepV2(db, { data_dir: tmpDir });

    // Simulate "DELETE-live didn't commit" by re-inserting into live with
    // the LIVE-marker payload (the invariant guarantees event_id stability).
    for (let i = 1; i <= 5; i++) {
      insertEvent(db, i, {
        emitted_at: apr + i,
        payload: JSON.stringify({ n: i, src: 'LIVE' }),
        dedup_expires_at: Date.now() + 86400000, // not eligible for re-sweep
      });
    }

    const rows = pollResolve(db, archDir, { lastEventId: 0, batchSize: 100 });

    expect(rows.length).toBe(5);
    expect(rows.map(r => r.event_id)).toEqual([1, 2, 3, 4, 5]);

    // Each event must come from the LIVE copy (round-3 dedupe-winner rule)
    for (const row of rows) {
      const parsed = JSON.parse(row.payload);
      expect(parsed.src).toBe('LIVE');
    }
  });

  // -------------------------------------------------------------------------
  // Bloat warning (WB-012)
  // -------------------------------------------------------------------------

  it('emits WB-012 bloat warning when live row count exceeds threshold', () => {
    const future = Date.now() + 1_000_000;
    // Insert 5 events that are NOT TTL'd, threshold = 3. Sweep moves nothing
    // but should still flag the bloat.
    for (let i = 1; i <= 5; i++) insertEvent(db, i, { dedup_expires_at: future });

    const result = runSweepV2(db, {
      data_dir: tmpDir,
      live_bloat_rows: 3,
    });

    expect(result.events_moved).toBe(0);
    expect(result.bloat_warning).toBeDefined();
    expect(result.bloat_warning.error).toBe('WB-012');
    expect(result.bloat_warning.code).toBe('LIVE_TIER_BLOAT_WARNING');
    expect(result.bloat_warning.context.row_count).toBe(5);
    expect(result.bloat_warning.context.row_threshold).toBe(3);
  });
});
