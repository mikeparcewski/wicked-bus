import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { runSweep } from '../../lib/sweep.js';

describe('event lifecycle: emit -> TTL -> sweep -> re-emit (AC-10)', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-lifecycle-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = loadConfig();
    db = openDb(config);
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
    if (originalEnv) {
      process.env.WICKED_BUS_DATA_DIR = originalEnv;
    } else {
      delete process.env.WICKED_BUS_DATA_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('after sweep removes row, same idempotency_key can be reused', () => {
    const key = randomUUID();

    // Emit event
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
      idempotency_key: key,
    });

    // Manually expire the event (set dedup_expires_at to past)
    db.prepare('UPDATE events SET dedup_expires_at = ? WHERE idempotency_key = ?')
      .run(Date.now() - 1000, key);

    // Sweep should delete it
    const sweepResult = runSweep(db, config);
    expect(sweepResult.events_deleted).toBe(1);

    // Re-emit with same key should succeed
    const result = emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
      idempotency_key: key,
    });
    expect(result.event_id).toBeTruthy();
  });

  it('dedup_expires_at and expires_at are independent', () => {
    const result = emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(result.event_id);
    // dedup_expires_at = emitted_at + 24h
    // expires_at = emitted_at + 72h
    expect(row.dedup_expires_at).toBeLessThan(row.expires_at);
    expect(row.expires_at - row.emitted_at).toBe(72 * 3_600_000);
    expect(row.dedup_expires_at - row.emitted_at).toBe(24 * 3_600_000);
  });
});
