/**
 * Warm-spill resolver tests — DESIGN-v2.md §14.1 fault-injection matrix.
 * Priority-1 scenarios: T1, T2, T3, T5, T7. (T8 needs sweep, deferred.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';
import { createBucket, sealBucket, archiveDir, ensureArchiveDir } from '../../lib/archive.js';
import { pollResolve, dedupePreferLive } from '../../lib/query.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mkEvent(eventId, overrides = {}) {
  return {
    event_id: eventId,
    event_type: 'wicked.test.fired',
    domain: 'test-domain',
    subdomain: '',
    payload: JSON.stringify({ n: eventId }),
    schema_version: '1.0.0',
    idempotency_key: `evt-${eventId}-${randomUUID()}`,
    emitted_at: 1700000000000 + eventId,
    expires_at: 1700000000000 + eventId + 86400000,
    dedup_expires_at: 1700000000000 + eventId + 86400000,
    metadata: null,
    ...overrides,
  };
}

function insertLive(db, event) {
  db.prepare(`
    INSERT INTO events
      (event_id, event_type, domain, subdomain, payload, schema_version,
       idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id, event.event_type, event.domain, event.subdomain,
    event.payload, event.schema_version, event.idempotency_key,
    event.emitted_at, event.expires_at, event.dedup_expires_at, event.metadata
  );
}

function insertWarm(bucketDb, event) {
  bucketDb.prepare(`
    INSERT INTO events
      (event_id, event_type, domain, subdomain, payload, schema_version,
       idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id, event.event_type, event.domain, event.subdomain,
    event.payload, event.schema_version, event.idempotency_key,
    event.emitted_at, event.expires_at, event.dedup_expires_at, event.metadata
  );
}

/**
 * Build a sealed warm bucket containing events with event_ids in [minId, maxId] inclusive.
 */
function buildBucket(archDir, name, minId, maxId) {
  const filepath = join(archDir, name);
  const db = createBucket(filepath, { minEventId: minId, maxEventId: maxId });
  for (let i = minId; i <= maxId; i++) insertWarm(db, mkEvent(i));
  db.close();
  sealBucket(filepath, { maxEventId: maxId });
  return filepath;
}

// ---------------------------------------------------------------------------

describe('warm-spill resolver (lib/query.js)', () => {
  let tmpDir;
  let archDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-query-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    archDir = archiveDir(tmpDir);
    ensureArchiveDir(archDir);
    db = openDb();
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* already closed */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // T1 — Empty-live warm-only poll (Pi's empty-live trap)
  // -------------------------------------------------------------------------
  it('T1: returns events from warm when live is empty (cursor=0, 50 events in warm)', () => {
    buildBucket(archDir, 'bus-2026-01.db', 1, 50);

    const rows = pollResolve(db, archDir, { lastEventId: 0, batchSize: 100 });

    expect(rows.length).toBe(50);
    expect(rows[0].event_id).toBe(1);
    expect(rows[49].event_id).toBe(50);
    // Strict ascending order
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].event_id).toBeGreaterThan(rows[i - 1].event_id);
    }
  });

  it('T1b: returns empty (no WB-003) when both tiers are empty and cursor is 0', () => {
    const rows = pollResolve(db, archDir, { lastEventId: 0, batchSize: 100 });
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // T2 — Cross-tier boundary poll
  // -------------------------------------------------------------------------
  it('T2: boundary poll across warm (1-60) and live (61-100), cursor=50', () => {
    buildBucket(archDir, 'bus-2026-01.db', 1, 60);
    for (let i = 61; i <= 100; i++) insertLive(db, mkEvent(i));

    const rows = pollResolve(db, archDir, { lastEventId: 50, batchSize: 100 });

    const ids = rows.map(r => r.event_id);
    const expected = [];
    for (let i = 51; i <= 100; i++) expected.push(i);
    expect(ids).toEqual(expected);

    // No duplicates
    expect(new Set(ids).size).toBe(ids.length);
  });

  // -------------------------------------------------------------------------
  // T3 — Crash-window duplicate (OpenCode's gap)
  // -------------------------------------------------------------------------
  it('T3: dedupes when same event_id is in both tiers, live copy wins', () => {
    // Realistic crash-window scenario per DESIGN-v2.md §5.1:
    //   - Sweep moved events 1-10 to warm (warm-COMMIT done for all).
    //   - Sweep then started live DELETE; events 1-4 deleted, then crash.
    //   - Result: warm has 1-10; live still has 5-10 (DELETE not committed
    //     for those rows). Cursor at 0.
    //   - minLive = 5, gap = [0, 4]. Warm bucket [1, 10] covers [0, 4]
    //     (intersects), so warm is queried. Warm returns 1-10.
    //   - Live returns 5-10. Dedupe collapses 5-10 (live wins; events 1-4
    //     come only from warm).
    //
    // Live payload differs so we can verify which copy was retained.
    buildBucket(archDir, 'bus-2026-01.db', 1, 10);
    for (let i = 5; i <= 10; i++) {
      insertLive(db, mkEvent(i, { payload: JSON.stringify({ n: i, src: 'LIVE' }) }));
    }

    const rows = pollResolve(db, archDir, { lastEventId: 0, batchSize: 100 });

    const ids = rows.map(r => r.event_id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Events 1-4 only exist in warm — payload has the default mkEvent shape.
    for (const row of rows.slice(0, 4)) {
      const parsed = JSON.parse(row.payload);
      expect(parsed.src, `warm-only event_id=${row.event_id} has no src marker`).toBeUndefined();
    }

    // Events 5-10 exist in both tiers — live copy must win (round-3 spec).
    for (const row of rows.slice(4)) {
      const parsed = JSON.parse(row.payload);
      expect(parsed.src, `event_id=${row.event_id} should be from live tier`).toBe('LIVE');
    }
  });

  it('T3b: dedupePreferLive helper keeps live copies when both arrays have the same event_id', () => {
    const warm = [{ event_id: 1, src: 'warm' }, { event_id: 2, src: 'warm' }];
    const live = [{ event_id: 2, src: 'live' }, { event_id: 3, src: 'live' }];
    const out = dedupePreferLive(warm, live);
    const byId = new Map(out.map(r => [r.event_id, r.src]));
    expect(byId.get(1)).toBe('warm');
    expect(byId.get(2)).toBe('live');     // live wins
    expect(byId.get(3)).toBe('live');
  });

  // -------------------------------------------------------------------------
  // T5 — Cursor behind live, covered by warm
  // -------------------------------------------------------------------------
  it('T5: cursor at 25, warm covers 1-50, live covers 51-100 → returns 26-100', () => {
    buildBucket(archDir, 'bus-2026-01.db', 1, 50);
    for (let i = 51; i <= 100; i++) insertLive(db, mkEvent(i));

    const rows = pollResolve(db, archDir, { lastEventId: 25, batchSize: 200 });

    const ids = rows.map(r => r.event_id);
    const expected = [];
    for (let i = 26; i <= 100; i++) expected.push(i);
    expect(ids).toEqual(expected);
  });

  // -------------------------------------------------------------------------
  // T4 — Cursor behind everything → WB-003
  // -------------------------------------------------------------------------
  it('T4: cursor before any covering bucket and no live coverage → WB-003', () => {
    // Live has events 100-110 (so MIN(live) = 100). No warm buckets cover
    // event_ids 0-99. Cursor at 50 → gap is unfillable.
    for (let i = 100; i <= 110; i++) insertLive(db, mkEvent(i));

    expect(() => pollResolve(db, archDir, { lastEventId: 50, batchSize: 100 }))
      .toThrow(/cursor points to events that have been deleted/);

    try {
      pollResolve(db, archDir, { lastEventId: 50, batchSize: 100 });
    } catch (e) {
      expect(e.error).toBe('WB-003');
      expect(e.code).toBe('CURSOR_BEHIND_TTL_WINDOW');
    }
  });

  // -------------------------------------------------------------------------
  // T7 — Multi-bucket ordering
  // -------------------------------------------------------------------------
  it('T7: strict ascending order across two warm buckets + live, cursor=4048', () => {
    buildBucket(archDir, 'bus-2026-01.db', 4001, 4050);
    buildBucket(archDir, 'bus-2026-02.db', 4051, 4100);
    for (let i = 4101; i <= 4120; i++) insertLive(db, mkEvent(i));

    const rows = pollResolve(db, archDir, { lastEventId: 4048, batchSize: 200 });

    const ids = rows.map(r => r.event_id);
    const expected = [];
    for (let i = 4049; i <= 4120; i++) expected.push(i);
    expect(ids).toEqual(expected);

    // Validate strict ascending (no gaps, no repeats)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1] + 1);
    }
  });

  // -------------------------------------------------------------------------
  // batch-size truncation
  // -------------------------------------------------------------------------
  it('truncates to batchSize after dedupe, keeping the smallest event_ids', () => {
    buildBucket(archDir, 'bus-2026-01.db', 1, 50);
    for (let i = 51; i <= 100; i++) insertLive(db, mkEvent(i));

    const rows = pollResolve(db, archDir, { lastEventId: 0, batchSize: 10 });

    expect(rows.length).toBe(10);
    expect(rows[0].event_id).toBe(1);
    expect(rows[9].event_id).toBe(10);
  });

  // -------------------------------------------------------------------------
  // filter applied to both tiers
  // -------------------------------------------------------------------------
  it('applies event_type filter to both warm and live tiers', () => {
    // Warm bucket has events of type wicked.test.fired (default in mkEvent)
    // Override one warm event and one live event with a different type.
    const filepath = join(archDir, 'bus-2026-01.db');
    const warmDb = createBucket(filepath, { minEventId: 1, maxEventId: 5 });
    insertWarm(warmDb, mkEvent(1));
    insertWarm(warmDb, mkEvent(2, { event_type: 'wicked.other.thing' }));
    insertWarm(warmDb, mkEvent(3));
    insertWarm(warmDb, mkEvent(4));
    insertWarm(warmDb, mkEvent(5));
    warmDb.close();
    sealBucket(filepath, { maxEventId: 5 });

    insertLive(db, mkEvent(6));
    insertLive(db, mkEvent(7, { event_type: 'wicked.other.thing' }));
    insertLive(db, mkEvent(8));

    const rows = pollResolve(db, archDir, {
      lastEventId: 0,
      filter: { event_type: 'wicked.test.fired' },
      batchSize: 100,
    });

    const ids = rows.map(r => r.event_id);
    expect(ids).toEqual([1, 3, 4, 5, 6, 8]);
  });
});
