import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';
import { migrate, currentVersion, TARGET_SCHEMA_VERSION } from '../../lib/migrate.js';

describe('migrate (v1 → v2 schema migration)', () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-migrate-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
  });

  afterEach(() => {
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('opens a fresh DB and lands schema_migrations at the target version', () => {
    const db = openDb();
    expect(currentVersion(db)).toBe(TARGET_SCHEMA_VERSION);
    expect(TARGET_SCHEMA_VERSION).toBe(3);
    db.close();
  });

  it('adds the v2 causality columns to events as nullable', () => {
    const db = openDb();
    const cols = db.prepare('PRAGMA table_info(events)').all();
    const names = cols.map(c => c.name);

    expect(names).toContain('parent_event_id');
    expect(names).toContain('session_id');
    expect(names).toContain('correlation_id');
    expect(names).toContain('producer_id');
    expect(names).toContain('origin_node_id');
    expect(names).toContain('registry_schema_version');
    expect(names).toContain('payload_cas_sha');

    // All v2 columns must be nullable so v1 callers continue to work
    for (const name of [
      'parent_event_id', 'session_id', 'correlation_id', 'producer_id',
      'origin_node_id', 'registry_schema_version', 'payload_cas_sha',
    ]) {
      const col = cols.find(c => c.name === name);
      expect(col.notnull, `${name} must be nullable`).toBe(0);
    }

    db.close();
  });

  it('preserves the existing v1 events.schema_version TEXT column (no collision)', () => {
    const db = openDb();
    const cols = db.prepare('PRAGMA table_info(events)').all();
    const v1Col = cols.find(c => c.name === 'schema_version');
    const v2Col = cols.find(c => c.name === 'registry_schema_version');

    expect(v1Col).toBeDefined();
    expect(v1Col.type).toBe('TEXT');           // v1: payload-schema string
    expect(v2Col).toBeDefined();
    expect(v2Col.type).toBe('INTEGER');         // v2: registry pointer
    db.close();
  });

  it('augments cursors with push_socket_addr and lag_estimate', () => {
    const db = openDb();
    const cols = db.prepare('PRAGMA table_info(cursors)').all();
    const names = cols.map(c => c.name);

    expect(names).toContain('push_socket_addr');
    expect(names).toContain('lag_estimate');
    db.close();
  });

  it('creates the schemas registry table with constraints', () => {
    const db = openDb();
    const cols = db.prepare('PRAGMA table_info(schemas)').all();
    expect(cols.length).toBeGreaterThan(0);

    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'event_type', 'version', 'json_schema', 'retention',
      'payload_max_bytes', 'archive_to', 'payload_oversize',
      'deprecated_at', 'sunset_at',
    ]));

    // CHECK constraint on retention
    expect(() => db.prepare(
      `INSERT INTO schemas(event_type, version, json_schema, retention)
       VALUES (?, ?, ?, ?)`
    ).run('test.event', 1, '{}', 'invalid-retention')).toThrow();

    // Valid insert
    db.prepare(
      `INSERT INTO schemas(event_type, version, json_schema)
       VALUES (?, ?, ?)`
    ).run('test.event', 1, '{}');

    db.close();
  });

  it('creates the v2 indexes on causality columns', () => {
    const db = openDb();
    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'`
    ).all().map(r => r.name);

    expect(indexes).toContain('idx_events_correlation_id');
    expect(indexes).toContain('idx_events_session_id');
    expect(indexes).toContain('idx_events_parent_event_id');
    db.close();
  });

  it('migrate() is idempotent — re-running is a no-op', () => {
    const db = openDb();
    const before = currentVersion(db);

    migrate(db);
    migrate(db);
    migrate(db);

    expect(currentVersion(db)).toBe(before);

    // schema_migrations should have exactly one row per applied version
    const rows = db.prepare(
      'SELECT version, COUNT(*) AS n FROM schema_migrations GROUP BY version'
    ).all();
    for (const r of rows) {
      expect(r.n, `version ${r.version} duplicated`).toBe(1);
    }
    db.close();
  });

  it('preserves v1 dead_letters and delivery_attempts tables (additive only)', () => {
    const db = openDb();
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map(r => r.name);

    expect(tables).toContain('dead_letters');
    expect(tables).toContain('delivery_attempts');
    expect(tables).toContain('events');
    expect(tables).toContain('subscriptions');
    expect(tables).toContain('cursors');
    expect(tables).toContain('schema_migrations');
    expect(tables).toContain('schemas');           // new in v2
    db.close();
  });

  it('records the v2 migration with version=3 and a description', () => {
    const db = openDb();
    const row = db.prepare(
      'SELECT version, description FROM schema_migrations WHERE version = 3'
    ).get();

    expect(row).toBeDefined();
    expect(row.version).toBe(3);
    expect(row.description).toMatch(/v2/i);
    db.close();
  });
});
