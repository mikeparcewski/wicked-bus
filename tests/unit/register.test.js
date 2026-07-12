import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { register, deregister, deregisterByPlugin } from '../../lib/register.js';
import { emit } from '../../lib/emit.js';
import { WBError } from '../../lib/errors.js';

describe('register', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-register-test-' + randomUUID());
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

  describe('provider registration', () => {
    it('creates subscription row', () => {
      const result = register(db, {
        plugin: 'wicked-testing',
        role: 'provider',
        filter: 'wicked.test.run.started,wicked.test.run.completed',
        schema_version: '1.0.0',
      });
      expect(result.subscription_id).toBeTruthy();
      expect(result.role).toBe('provider');

      const sub = db.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?')
        .get(result.subscription_id);
      expect(sub).toBeTruthy();
      expect(sub.role).toBe('provider');
    });

    it('writes sidecar JSON', () => {
      register(db, {
        plugin: 'wicked-testing',
        role: 'provider',
        filter: 'wicked.test.run.started',
      });
      const sidecarPath = join(tmpDir, 'providers', 'wicked-testing.json');
      expect(existsSync(sidecarPath)).toBe(true);
    });
  });

  describe('subscriber registration', () => {
    it('creates subscription and cursor rows', () => {
      const result = register(db, {
        plugin: 'test-consumer',
        role: 'subscriber',
        filter: 'wicked.test.run.*',
        cursor_init: 'oldest',
      });
      expect(result.subscription_id).toBeTruthy();
      expect(result.cursor_id).toBeTruthy();
      expect(result.last_event_id).toBe(0);
    });

    it('cursor_init=latest sets last_event_id to MAX(event_id)', () => {
      emit(db, config, {
        event_type: 'wicked.test.run.completed',
        domain: 'wicked-testing',
        payload: { test: true },
      });
      emit(db, config, {
        event_type: 'wicked.test.run.started',
        domain: 'wicked-testing',
        payload: { test: true },
      });

      const result = register(db, {
        plugin: 'test-consumer',
        role: 'subscriber',
        filter: 'wicked.test.run.*',
        cursor_init: 'latest',
      });
      expect(result.last_event_id).toBe(2);
    });

    it('cursor_init=oldest sets last_event_id to 0', () => {
      emit(db, config, {
        event_type: 'wicked.test.run.completed',
        domain: 'wicked-testing',
        payload: { test: true },
      });

      const result = register(db, {
        plugin: 'test-consumer',
        role: 'subscriber',
        filter: 'wicked.test.run.*',
        cursor_init: 'oldest',
      });
      expect(result.last_event_id).toBe(0);
    });

    it('cursor_init=latest returns 0 when no events exist', () => {
      const result = register(db, {
        plugin: 'test-consumer',
        role: 'subscriber',
        filter: 'wicked.test.run.*',
        cursor_init: 'latest',
      });
      expect(result.last_event_id).toBe(0);
    });
  });
});

describe('deregister', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-dereg-test-' + randomUUID());
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

  it('soft-deletes subscriber subscription and cursor', () => {
    const reg = register(db, {
      plugin: 'test-consumer',
      role: 'subscriber',
      filter: 'wicked.test.*',
      cursor_init: 'oldest',
    });

    const result = deregister(db, reg.subscription_id);
    expect(result.deregistered).toBe(true);

    const sub = db.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?')
      .get(reg.subscription_id);
    expect(sub.deregistered_at).toBeTruthy();

    const cursor = db.prepare('SELECT * FROM cursors WHERE cursor_id = ?')
      .get(reg.cursor_id);
    expect(cursor.deregistered_at).toBeTruthy();
  });

  it('removes provider sidecar on deregister', () => {
    const reg = register(db, {
      plugin: 'wicked-testing',
      role: 'provider',
      filter: 'wicked.test.run.completed',
    });
    expect(existsSync(join(tmpDir, 'providers', 'wicked-testing.json'))).toBe(true);

    deregister(db, reg.subscription_id);
    expect(existsSync(join(tmpDir, 'providers', 'wicked-testing.json'))).toBe(false);
  });

  it('throws WB-006 when subscription not found', () => {
    expect(() => deregister(db, 'nonexistent-id')).toThrowError();
    try {
      deregister(db, 'nonexistent-id');
    } catch (err) {
      expect(err).toBeInstanceOf(WBError);
      expect(err.error).toBe('WB-006');
    }
  });

  it('events remain unaffected after deregistration', () => {
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
    });

    const reg = register(db, {
      plugin: 'test-consumer',
      role: 'subscriber',
      filter: 'wicked.test.*',
      cursor_init: 'oldest',
    });

    deregister(db, reg.subscription_id);

    const count = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    expect(count).toBe(1);
  });
});

describe('deregisterByPlugin', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-dereg-plugin-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = loadConfig();
    db = openDb(config);
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('soft-deletes every active subscription (and cursor) for a plugin', () => {
    const a = register(db, {
      plugin: 'wi-agent', role: 'subscriber', filter: 'wicked.test.*', cursor_init: 'oldest',
    });
    const b = register(db, {
      plugin: 'wi-agent', role: 'subscriber', filter: 'wicked.crew.*', cursor_init: 'oldest',
    });

    const result = deregisterByPlugin(db, 'wi-agent');
    expect(result.deregistered).toBe(true);
    expect(result.count).toBe(2);
    expect(result.subscription_ids).toEqual(
      expect.arrayContaining([a.subscription_id, b.subscription_id])
    );

    for (const reg of [a, b]) {
      const sub = db.prepare('SELECT deregistered_at FROM subscriptions WHERE subscription_id = ?')
        .get(reg.subscription_id);
      expect(sub.deregistered_at).toBeTruthy();
      const cursor = db.prepare('SELECT deregistered_at FROM cursors WHERE cursor_id = ?')
        .get(reg.cursor_id);
      expect(cursor.deregistered_at).toBeTruthy();
    }
  });

  it('leaves other plugins untouched', () => {
    register(db, { plugin: 'wi-agent', role: 'subscriber', filter: 'wicked.test.*', cursor_init: 'oldest' });
    const keep = register(db, { plugin: 'other', role: 'subscriber', filter: 'wicked.test.*', cursor_init: 'oldest' });

    deregisterByPlugin(db, 'wi-agent');

    const sub = db.prepare('SELECT deregistered_at FROM subscriptions WHERE subscription_id = ?')
      .get(keep.subscription_id);
    expect(sub.deregistered_at).toBeNull();
  });

  it('can restrict to a single role', () => {
    const sub = register(db, { plugin: 'dual', role: 'subscriber', filter: 'wicked.test.*', cursor_init: 'oldest' });
    const prov = register(db, { plugin: 'dual', role: 'provider', filter: 'wicked.test.run.completed' });

    const result = deregisterByPlugin(db, 'dual', { role: 'subscriber' });
    expect(result.count).toBe(1);

    const subRow = db.prepare('SELECT deregistered_at FROM subscriptions WHERE subscription_id = ?')
      .get(sub.subscription_id);
    expect(subRow.deregistered_at).toBeTruthy();
    const provRow = db.prepare('SELECT deregistered_at FROM subscriptions WHERE subscription_id = ?')
      .get(prov.subscription_id);
    expect(provRow.deregistered_at).toBeNull();
  });

  it('throws WB-006 when no active subscription matches the plugin', () => {
    try {
      deregisterByPlugin(db, 'ghost');
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WBError);
      expect(err.error).toBe('WB-006');
    }
  });

  it('is idempotent — a second call finds nothing active and throws WB-006', () => {
    register(db, { plugin: 'wi-agent', role: 'subscriber', filter: 'wicked.test.*', cursor_init: 'oldest' });
    deregisterByPlugin(db, 'wi-agent');
    expect(() => deregisterByPlugin(db, 'wi-agent')).toThrow(WBError);
  });
});
