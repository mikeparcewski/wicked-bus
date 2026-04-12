import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { runSweep, startSweep } from '../../lib/sweep.js';

describe('sweep', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-sweep-test-' + randomUUID());
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

  function emitExpiredEvent() {
    // Insert event with dedup_expires_at in the past
    const now = Date.now();
    db.prepare(`
      INSERT INTO events (event_type, domain, payload, schema_version,
        idempotency_key, emitted_at, expires_at, dedup_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'wicked.test.run.completed',
      'wicked-testing',
      '{"test":true}',
      '1.0.0',
      randomUUID(),
      now - 100_000,
      now + 100_000, // expires_at still in future
      now - 1, // dedup_expires_at in the past
    );
  }

  it('deletes events where dedup_expires_at < now', () => {
    emitExpiredEvent();
    const before = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    expect(before).toBe(1);

    const result = runSweep(db, config);
    expect(result.events_deleted).toBe(1);

    const after = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    expect(after).toBe(0);
  });

  it('does not delete events where dedup_expires_at >= now', () => {
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
    });
    const result = runSweep(db, config);
    expect(result.events_deleted).toBe(0);
  });

  it('archives events when archive_mode is true', () => {
    emitExpiredEvent();
    const archiveConfig = { ...config, archive_mode: true };
    runSweep(db, archiveConfig);

    const archived = db.prepare('SELECT COUNT(*) as c FROM events_archive').get().c;
    expect(archived).toBe(1);
    const remaining = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    expect(remaining).toBe(0);
  });

  it('does not create archive table when archive_mode is false', () => {
    emitExpiredEvent();
    runSweep(db, { ...config, archive_mode: false });
    // events_archive should not exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events_archive'"
    ).all();
    expect(tables).toHaveLength(0);
  });

  it('startSweep returns null when sweep_interval_minutes is 0', () => {
    const handle = startSweep(db, { ...config, sweep_interval_minutes: 0 });
    expect(handle).toBeNull();
  });

  it('startSweep returns interval handle when enabled', () => {
    const handle = startSweep(db, { ...config, sweep_interval_minutes: 1 });
    expect(handle).toBeTruthy();
    clearInterval(handle);
  });
});
