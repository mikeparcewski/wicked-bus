/**
 * Which timestamp decides a row's LIFE (#85, superseded by FND-BUS-01 / #101).
 *
 * `events` carries two expiries and, since 2.4, they mean exactly one thing each:
 *
 *   - `expires_at` = `emitted_at + ttl_hours` (default 72 h, per-event overridable) — the event's
 *     LIFETIME. Both sweep paths key on it, and an expired event an active cursor still owes is
 *     kept under the default `unacked_policy: 'retain'` (tests/integration/retention-policy.test.js).
 *   - `dedup_expires_at` = `emitted_at + dedup_ttl_hours` (default 24 h) — the IDEMPOTENCY window
 *     only: within it a reused key is WB-002; after it emit() releases the key from the still-living
 *     row and accepts the new event (so lib/dlq.js replay re-emission keeps working).
 *
 * #85 had pinned the opposite (delete at 24 h, hide at 72 h). The foundation audit (FND-BUS-01)
 * showed that deleted unacked events a day after emission while the visibility window promised
 * three days, so the key was moved and this file now pins the new one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { poll } from '../../lib/poll.js';
import { register } from '../../lib/register.js';
import { runSweep } from '../../lib/sweep.js';
import { runSweepV2 } from '../../lib/sweep-v2.js';

const HOUR = 3_600_000;

describe('retention keys on expires_at, dedup on dedup_expires_at (#101)', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-retention-key-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = loadConfig();
    db = openDb(config);
  });

  afterEach(() => {
    try { db.close(); } catch (_) { /* already closed */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  /** A row with the two expiries placed exactly where the test wants them. */
  function insertRow({ dedupOffsetMs, ttlOffsetMs, key = randomUUID() }) {
    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO events (event_type, domain, payload, schema_version,
        idempotency_key, emitted_at, expires_at, dedup_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'wicked.test.run.completed', 'wicked-bus', '{"n":1}', '1.0.0',
      key, now - 100, now + ttlOffsetMs, now + dedupOffsetMs,
    );
    return Number(info.lastInsertRowid);
  }

  const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

  it('defaults put the dedup window at 24 h and the lifetime at 72 h', () => {
    expect(config.dedup_ttl_hours).toBe(24);
    expect(config.ttl_hours).toBe(72);
    const before = Date.now();
    emit(db, config, {
      event_type: 'wicked.test.run.completed', domain: 'wicked-bus', payload: { n: 1 },
    });
    const row = db.prepare('SELECT emitted_at, expires_at, dedup_expires_at FROM events').get();
    expect(row.emitted_at).toBeGreaterThanOrEqual(before);
    expect(row.dedup_expires_at - row.emitted_at).toBe(24 * HOUR);
    expect(row.expires_at - row.emitted_at).toBe(72 * HOUR);
  });

  it('runSweep keeps a row past dedup_expires_at whose expires_at is still in the future', () => {
    // THE defining case: at defaults this is every row between T+24 h and T+72 h.
    insertRow({ dedupOffsetMs: -HOUR, ttlOffsetMs: 48 * HOUR });
    expect(runSweep(db, config).events_deleted).toBe(0);
    expect(rowCount()).toBe(1);
  });

  it('runSweep deletes a row past expires_at that no cursor owes', () => {
    insertRow({ dedupOffsetMs: -2 * HOUR, ttlOffsetMs: -HOUR });
    expect(runSweep(db, config).events_deleted).toBe(1);
    expect(rowCount()).toBe(0);
  });

  it('runSweepV2 moves the same rows to warm storage, and only those', () => {
    insertRow({ dedupOffsetMs: -HOUR, ttlOffsetMs: 48 * HOUR });
    const doomed = insertRow({ dedupOffsetMs: -2 * HOUR, ttlOffsetMs: -HOUR });
    const result = runSweepV2(db, { data_dir: tmpDir });
    expect(result.events_moved).toBe(1);
    const left = db.prepare('SELECT event_id FROM events').all().map((r) => r.event_id);
    expect(left).not.toContain(doomed);
    expect(left).toHaveLength(1);
  });

  it('poll() delivers an expired row the sweep kept for an owing cursor', () => {
    const expiredId = insertRow({ dedupOffsetMs: -2 * HOUR, ttlOffsetMs: -HOUR });
    const liveId = insertRow({ dedupOffsetMs: HOUR, ttlOffsetMs: HOUR });
    const reg = register(db, {
      plugin: 'test-consumer', role: 'subscriber',
      filter: 'wicked.test.run.*', cursor_init: 'oldest',
    });
    expect(runSweep(db, config).events_deleted).toBe(0); // owed -> retained
    const delivered = poll(db, reg.cursor_id);
    expect(delivered.map((e) => e.event_id)).toEqual([expiredId, liveId]);
  });

  it('an emit re-using a key whose dedup window passed is accepted — lib/dlq.js replay depends on it', () => {
    const key = 'replay-me-' + randomUUID();
    const original = insertRow({ dedupOffsetMs: -HOUR, ttlOffsetMs: 48 * HOUR, key });
    runSweep(db, config);
    expect(rowCount()).toBe(1); // the original still lives out its lifetime
    const res = emit(db, config, {
      event_type: 'wicked.test.run.completed', domain: 'wicked-bus', payload: { n: 2 },
      idempotency_key: key,
    });
    expect(res.event_id).not.toBe(original);
    expect(db.prepare('SELECT event_id FROM events WHERE idempotency_key = ?').get(key).event_id).toBe(res.event_id);
  });

  it('an emit re-using a key inside its dedup window is still WB-002', () => {
    const key = 'dup-' + randomUUID();
    insertRow({ dedupOffsetMs: HOUR, ttlOffsetMs: 48 * HOUR, key });
    expect(() => emit(db, config, {
      event_type: 'wicked.test.run.completed', domain: 'wicked-bus', payload: { n: 2 },
      idempotency_key: key,
    })).toThrow(/Duplicate idempotency_key/);
  });
});
