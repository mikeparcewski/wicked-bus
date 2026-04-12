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

describe('emit -> poll -> ack cycle', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-int-test-' + randomUUID());
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

  it('full emit -> poll -> ack -> poll returns empty', () => {
    // Emit
    const { event_id } = emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { runId: 'r1', status: 'passed' },
    });
    expect(event_id).toBe(1);

    // Register subscriber
    const reg = register(db, {
      plugin: 'test-consumer',
      role: 'subscriber',
      filter: 'wicked.test.run.*',
      cursor_init: 'oldest',
    });

    // Poll
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe(1);

    // Ack
    const ackResult = ack(db, reg.cursor_id, events[0].event_id);
    expect(ackResult.acked).toBe(true);

    // Poll again -- should be empty
    const events2 = poll(db, reg.cursor_id);
    expect(events2).toHaveLength(0);
  });

  it('at-least-once delivery on restart (AC-8)', () => {
    // Emit events
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { id: 1 },
    });
    emit(db, config, {
      event_type: 'wicked.test.run.started',
      domain: 'wicked-testing',
      payload: { id: 2 },
    });

    // Register and poll
    const reg = register(db, {
      plugin: 'test-consumer',
      role: 'subscriber',
      filter: 'wicked.test.run.*',
      cursor_init: 'oldest',
    });

    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(2);

    // Simulate crash -- no ack
    // Poll again -- re-delivers from last_event_id + 1
    const events2 = poll(db, reg.cursor_id);
    expect(events2).toHaveLength(2); // All events re-delivered
  });

  it('multiple subscribers receive same events independently', () => {
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
    });

    const sub1 = register(db, {
      plugin: 'consumer-1',
      role: 'subscriber',
      filter: 'wicked.test.run.*',
      cursor_init: 'oldest',
    });
    const sub2 = register(db, {
      plugin: 'consumer-2',
      role: 'subscriber',
      filter: 'wicked.test.run.*',
      cursor_init: 'oldest',
    });

    const events1 = poll(db, sub1.cursor_id);
    const events2 = poll(db, sub2.cursor_id);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    // Ack from sub1 only
    ack(db, sub1.cursor_id, events1[0].event_id);

    // sub1 poll empty, sub2 still gets events
    expect(poll(db, sub1.cursor_id)).toHaveLength(0);
    expect(poll(db, sub2.cursor_id)).toHaveLength(1);
  });
});
