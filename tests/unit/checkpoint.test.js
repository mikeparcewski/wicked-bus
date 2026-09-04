import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { runCheckpoint, startCheckpoint } from '../../lib/checkpoint.js';

const require = createRequire(import.meta.url);

describe('checkpoint', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-checkpoint-test-' + randomUUID());
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

  function emitEvent() {
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
    });
  }

  function walSize() {
    return statSync(join(tmpDir, 'bus.db-wal')).size;
  }

  it('openDb applies the wal_autocheckpoint backstop', () => {
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(512);
  });

  it('runCheckpoint truncates the WAL and reads survive', () => {
    emitEvent();
    expect(walSize()).toBeGreaterThan(0); // writes land in the WAL first

    const result = runCheckpoint(db);
    expect(result.busy).toBe(false);
    expect(result.log).toBeGreaterThanOrEqual(0);
    expect(result.checkpointed).toBe(result.log); // every frame reached bus.db
    expect(walSize()).toBe(0); // TRUNCATE leaves a zero-byte -wal

    // Reads survive the truncate, and the WAL restarts cleanly for new writes.
    expect(db.prepare('SELECT COUNT(*) AS c FROM events').get().c).toBe(1);
    emitEvent();
    expect(db.prepare('SELECT COUNT(*) AS c FROM events').get().c).toBe(2);
  });

  it('restores busy_timeout after the attempt', () => {
    emitEvent();
    runCheckpoint(db);
    // openDb sets 5000; runCheckpoint zeroes it for the attempt and restores it.
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('restores a legitimate prior busy_timeout of 0 exactly', () => {
    // A caller that deliberately runs with busy waiting disabled must get its
    // exact value back — not openDb's 5000 (the `Number(prev) || 5000` trap).
    db.pragma('busy_timeout = 0');
    emitEvent();
    runCheckpoint(db);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(0);
    db.pragma('busy_timeout = 5000'); // restore for the shared afterEach teardown
  });

  it('a concurrent reader makes the truncate defer (busy), never throw or block', () => {
    emitEvent();

    // A second read-only connection with a PINNED snapshot — the long-lived
    // subscriber shape. Its read mark sits in the WAL.
    const Database = require('better-sqlite3');
    const reader = new Database(join(tmpDir, 'bus.db'), { readonly: true });
    try {
      reader.exec('BEGIN');
      const seen = reader.prepare('SELECT COUNT(*) AS c FROM events').get().c;
      expect(seen).toBe(1);

      // New frames PAST the reader's mark ⇒ neither backfill nor restart completes.
      emitEvent();

      const deferred = runCheckpoint(db);
      expect(deferred.busy).toBe(true); // deferred, not an error
      expect(walSize()).toBeGreaterThan(0); // WAL left in place

      // The reader's snapshot is untouched by the attempt.
      expect(reader.prepare('SELECT COUNT(*) AS c FROM events').get().c).toBe(seen);

      reader.exec('COMMIT');
    } finally {
      reader.close();
    }

    // Reader gone ⇒ the next pass completes.
    const done = runCheckpoint(db);
    expect(done.busy).toBe(false);
    expect(walSize()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM events').get().c).toBe(2);
  });

  it('startCheckpoint returns null when checkpoint_interval_minutes is 0', () => {
    const handle = startCheckpoint(db, { ...config, checkpoint_interval_minutes: 0 });
    expect(handle).toBeNull();
  });

  it('startCheckpoint applies the documented default when the key or config is absent', () => {
    // Calling startCheckpoint at all is the opt-in: an absent key (a config
    // written before this feature) or an absent config gets the default 5.
    const noKey = startCheckpoint(db, {});
    expect(noKey).toBeTruthy();
    clearInterval(noKey);
    const noConfig = startCheckpoint(db);
    expect(noConfig).toBeTruthy();
    clearInterval(noConfig);
  });

  it('startCheckpoint runs on the interval and is cleaned up by clearInterval', () => {
    vi.useFakeTimers();
    try {
      emitEvent();
      expect(walSize()).toBeGreaterThan(0);

      const handle = startCheckpoint(db, { ...config, checkpoint_interval_minutes: 1 });
      expect(handle).toBeTruthy();

      vi.advanceTimersByTime(60_000);
      expect(walSize()).toBe(0); // the tick checkpointed

      // Cleared handle ⇒ no further ticks touch the (now closable) db.
      clearInterval(handle);
      emitEvent();
      const sizeAfterClear = walSize();
      vi.advanceTimersByTime(10 * 60_000);
      expect(walSize()).toBe(sizeAfterClear); // nothing ran after clearInterval
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoint errors inside the interval are non-fatal', () => {
    vi.useFakeTimers();
    try {
      const closed = openDb(config); // second handle we can close under the timer
      const handle = startCheckpoint(closed, { ...config, checkpoint_interval_minutes: 1 });
      closed.close();
      // A tick against a closed db throws inside runCheckpoint — swallowed.
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });
});
