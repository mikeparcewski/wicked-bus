import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { poll, ack } from '../../lib/poll.js';
import { register } from '../../lib/register.js';
import { WBError } from '../../lib/errors.js';

describe('poll', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-poll-test-' + randomUUID());
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

  function emitEvent(type = 'wicked.test.run.completed', source = 'wicked-testing') {
    return emit(db, config, {
      event_type: type,
      domain: source,
      payload: { test: true },
    });
  }

  function registerSub(filter = 'wicked.test.run.*', cursorInit = 'oldest') {
    return register(db, {
      plugin: 'test-consumer',
      role: 'subscriber',
      filter,
      cursor_init: cursorInit,
    });
  }

  it('returns events matching filter', () => {
    emitEvent();
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('wicked.test.run.completed');
  });

  it('returns events in event_id ASC order', () => {
    emitEvent('wicked.test.run.started');
    emitEvent('wicked.test.run.completed');
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events[0].event_id).toBeLessThan(events[1].event_id);
  });

  it('limits results by batchSize', () => {
    for (let i = 0; i < 5; i++) emitEvent();
    const reg = registerSub();
    const events = poll(db, reg.cursor_id, { batchSize: 2 });
    expect(events).toHaveLength(2);
  });

  it('excludes events before cursor position', () => {
    emitEvent();
    emitEvent();
    const reg = registerSub('wicked.test.run.*', 'latest');
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(0);
  });

  it('excludes expired events (expires_at < now)', () => {
    // Emit with very short TTL
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
      ttl_hours: 0, // expires immediately
    });
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(0);
  });

  it('throws WB-006 for non-existent cursor', () => {
    expect(() => poll(db, 'nonexistent')).toThrow(WBError);
    try {
      poll(db, 'nonexistent');
    } catch (err) {
      expect(err.error).toBe('WB-006');
    }
  });

  it('throws WB-006 for deregistered cursor', () => {
    emitEvent();
    const reg = registerSub();
    // Deregister cursor
    db.prepare('UPDATE cursors SET deregistered_at = ? WHERE cursor_id = ?')
      .run(Date.now(), reg.cursor_id);
    expect(() => poll(db, reg.cursor_id)).toThrow(WBError);
  });

  it('throws WB-003 when cursor is behind oldest row', () => {
    // Emit 5 events
    for (let i = 0; i < 5; i++) emitEvent();
    // Register subscriber starting from oldest
    const reg = registerSub('wicked.test.run.*', 'oldest');
    // Delete events 1-3 to simulate sweep
    db.prepare('DELETE FROM events WHERE event_id <= 3').run();

    try {
      poll(db, reg.cursor_id);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-003');
      expect(err.context.cursor_last_event_id).toBe(0);
      expect(err.context.oldest_available_event_id).toBe(4);
    }
  });

  it('does not throw WB-003 when cursor is at MIN(event_id) - 1', () => {
    for (let i = 0; i < 3; i++) emitEvent();
    // Delete event 1, so MIN = 2
    db.prepare('DELETE FROM events WHERE event_id = 1').run();
    // Set cursor to 1 (which is MIN(2) - 1)
    const reg = registerSub();
    db.prepare('UPDATE cursors SET last_event_id = 1 WHERE cursor_id = ?')
      .run(reg.cursor_id);
    // Should NOT throw
    const events = poll(db, reg.cursor_id);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('does not throw WB-003 when events table is empty', () => {
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(0);
  });
});

describe('ack', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-ack-test-' + randomUUID());
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

  it('atomically advances cursor', () => {
    const reg = register(db, {
      plugin: 'test-sub',
      role: 'subscriber',
      filter: 'wicked.test.*',
      cursor_init: 'oldest',
    });
    const result = ack(db, reg.cursor_id, 5);
    expect(result.acked).toBe(true);
    expect(result.cursor_id).toBe(reg.cursor_id);
    expect(result.last_event_id).toBe(5);

    const cursor = db.prepare('SELECT * FROM cursors WHERE cursor_id = ?').get(reg.cursor_id);
    expect(cursor.last_event_id).toBe(5);
    expect(cursor.acked_at).toBeTruthy();
  });

  it('throws WB-006 for non-existent cursor', () => {
    try {
      ack(db, 'nonexistent', 5);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-006');
    }
  });

  it('throws WB-006 for deregistered cursor', () => {
    const reg = register(db, {
      plugin: 'test-sub',
      role: 'subscriber',
      filter: 'wicked.test.*',
      cursor_init: 'oldest',
    });
    db.prepare('UPDATE cursors SET deregistered_at = ? WHERE cursor_id = ?')
      .run(Date.now(), reg.cursor_id);
    expect(() => ack(db, reg.cursor_id, 5)).toThrow(WBError);
  });
});
