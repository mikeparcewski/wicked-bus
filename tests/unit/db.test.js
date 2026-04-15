import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';

describe('db', () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-db-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.WICKED_BUS_DATA_DIR = originalEnv;
    } else {
      delete process.env.WICKED_BUS_DATA_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('creates DB with WAL journal mode', () => {
    const db = openDb({});
    const result = db.pragma('journal_mode');
    expect(result[0].journal_mode).toBe('wal');
    db.close();
  });

  it('sets synchronous to NORMAL', () => {
    const db = openDb({});
    const result = db.pragma('synchronous');
    // 1 = NORMAL
    expect(result[0].synchronous).toBe(1);
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDb({});
    const result = db.pragma('foreign_keys');
    expect(result[0].foreign_keys).toBe(1);
    db.close();
  });

  it('sets busy_timeout to 5000', () => {
    const db = openDb({});
    const result = db.pragma('busy_timeout');
    expect(result[0].timeout).toBe(5000);
    db.close();
  });

  it('creates events table with correct columns', () => {
    const db = openDb({});
    const cols = db.prepare("PRAGMA table_info(events)").all();
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('event_id');
    expect(colNames).toContain('event_type');
    expect(colNames).toContain('domain');
    expect(colNames).toContain('payload');
    expect(colNames).toContain('schema_version');
    expect(colNames).toContain('idempotency_key');
    expect(colNames).toContain('emitted_at');
    expect(colNames).toContain('expires_at');
    expect(colNames).toContain('dedup_expires_at');
    expect(colNames).toContain('metadata');
    db.close();
  });

  it('creates subscriptions table', () => {
    const db = openDb({});
    const cols = db.prepare("PRAGMA table_info(subscriptions)").all();
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('subscription_id');
    expect(colNames).toContain('plugin');
    expect(colNames).toContain('role');
    expect(colNames).toContain('event_type_filter');
    db.close();
  });

  it('creates cursors table with FK to subscriptions', () => {
    const db = openDb({});
    const fks = db.prepare("PRAGMA foreign_key_list(cursors)").all();
    expect(fks.length).toBeGreaterThan(0);
    expect(fks[0].table).toBe('subscriptions');
    db.close();
  });

  it('seeds schema_migrations through version 2', () => {
    const db = openDb({});
    const row = db.prepare('SELECT MAX(version) as max_version FROM schema_migrations').get();
    expect(row.max_version).toBe(2);
    db.close();
  });

  it('creates dead_letters table with denormalized event fields', () => {
    const db = openDb({});
    const cols = db.prepare("PRAGMA table_info(dead_letters)").all();
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('dl_id');
    expect(colNames).toContain('cursor_id');
    expect(colNames).toContain('subscription_id');
    expect(colNames).toContain('event_id');
    expect(colNames).toContain('event_type');
    expect(colNames).toContain('domain');
    expect(colNames).toContain('subdomain');
    expect(colNames).toContain('payload');
    expect(colNames).toContain('emitted_at');
    expect(colNames).toContain('attempts');
    expect(colNames).toContain('last_error');
    expect(colNames).toContain('dead_lettered_at');
    db.close();
  });

  it('creates delivery_attempts table with composite PK', () => {
    const db = openDb({});
    const cols = db.prepare("PRAGMA table_info(delivery_attempts)").all();
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('cursor_id');
    expect(colNames).toContain('event_id');
    expect(colNames).toContain('attempts');
    expect(colNames).toContain('last_attempt_at');
    expect(colNames).toContain('last_error');
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkCols).toEqual(['cursor_id', 'event_id']);
    db.close();
  });

  it('creates all indexes', () => {
    const db = openDb({});
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index'"
    ).all();
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_events_event_type');
    expect(indexNames).toContain('idx_events_emitted_at');
    expect(indexNames).toContain('idx_events_expires_at');
    expect(indexNames).toContain('idx_events_dedup_expires_at');
    expect(indexNames).toContain('idx_subscriptions_plugin');
    expect(indexNames).toContain('idx_subscriptions_active');
    expect(indexNames).toContain('idx_cursors_subscription_id');
    expect(indexNames).toContain('idx_cursors_active');
    db.close();
  });

  it('is idempotent -- opening twice does not error', () => {
    const db1 = openDb({});
    db1.close();
    const db2 = openDb({});
    const row = db2.prepare('SELECT COUNT(*) as c FROM schema_migrations').get();
    expect(row.c).toBe(2);
    db2.close();
  });

  it('enforces role CHECK constraint on subscriptions', () => {
    const db = openDb({});
    expect(() => {
      db.prepare(`
        INSERT INTO subscriptions (subscription_id, plugin, role, event_type_filter, registered_at)
        VALUES ('test', 'test', 'invalid_role', 'wicked.*', ${Date.now()})
      `).run();
    }).toThrow();
    db.close();
  });
});
