/**
 * Integration test: emit() honors the registered schema policy and round-trips
 * the registry pointer + CAS offload through SQLite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { exists as casExists, get as casGet } from '../../lib/cas.js';

function registerSchema(db, eventType, opts = {}) {
  db.prepare(`
    INSERT INTO schemas (
      event_type, version, json_schema, retention,
      payload_max_bytes, archive_to, payload_oversize
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    opts.version           ?? 1,
    opts.json_schema       ?? '{}',
    opts.retention         ?? 'default',
    opts.payload_max_bytes ?? 16384,
    opts.archive_to        ?? 'warm',
    opts.payload_oversize  ?? 'warn',
  );
}

// ---------------------------------------------------------------------------

describe('emit() × schema registry — integration', () => {
  let tmpDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-emit-reg-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    db = openDb();
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* ignore */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  it('emit without a registered schema preserves v1 behavior (registry_schema_version = NULL)', () => {
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    const r = emit(db, config, {
      event_type: 'wicked.unregistered.thing',
      domain: 'd',
      payload: { hello: 'world' },
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(JSON.parse(row.payload)).toEqual({ hello: 'world' });
    expect(row.registry_schema_version).toBeNull();
    expect(row.payload_cas_sha).toBeNull();
  });

  it('emit with a matching schema attaches registry_schema_version', () => {
    registerSchema(db, 'wicked.test.fired', {
      version: 4,
      json_schema: JSON.stringify({ type: 'object' }),
    });
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };

    const r = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: { ok: true },
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row.registry_schema_version).toBe(4);
    expect(row.payload_cas_sha).toBeNull();
  });

  it('cas-auto: oversize payload is offloaded; row stores {$cas:sha} + payload_cas_sha', () => {
    registerSchema(db, 'wicked.test.fired', {
      payload_max_bytes: 16,
      payload_oversize: 'cas-auto',
      json_schema: JSON.stringify({ type: 'object' }),
    });
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    const big = { data: 'x'.repeat(50) };

    const r = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: big,
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row.payload_cas_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(row.payload)).toEqual({ $cas: row.payload_cas_sha });
    expect(casExists(tmpDir, row.payload_cas_sha)).toBe(true);

    // Round-trip: full content recoverable from CAS
    const recovered = JSON.parse(casGet(tmpDir, row.payload_cas_sha).toString('utf8'));
    expect(recovered).toEqual(big);
  });

  it('strict: oversize payloads cause emit() to throw WB-008', () => {
    registerSchema(db, 'wicked.test.fired', {
      payload_max_bytes: 16,
      payload_oversize: 'strict',
    });
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };

    expect(() => emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: { data: 'x'.repeat(50) },
    })).toThrow(expect.objectContaining({ error: 'WB-008' }));

    // Emit must NOT have inserted anything when it threw before INSERT
    const count = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    expect(count).toBe(0);
  });

  it('warn: oversize payloads still insert; row keeps full inline payload', () => {
    registerSchema(db, 'wicked.test.fired', {
      payload_max_bytes: 16,
      payload_oversize: 'warn',
    });
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    const payload = { data: 'x'.repeat(50) };

    const r = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload,
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row.payload_cas_sha).toBeNull();
    expect(JSON.parse(row.payload)).toEqual(payload);                       // unchanged
  });

  it('schema mismatch in warn mode does NOT block the insert', () => {
    registerSchema(db, 'wicked.test.fired', {
      json_schema: JSON.stringify({
        type: 'object',
        required: ['user_id'],
        properties: { user_id: { type: 'integer' } },
      }),
    });
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };

    const r = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: { user_id: 'not-a-number' },                                 // violates type
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row).toBeDefined();
    expect(JSON.parse(row.payload).user_id).toBe('not-a-number');
  });

  it('schemas table coexists with v1 events.schema_version TEXT (no name collision)', () => {
    registerSchema(db, 'wicked.test.fired', { version: 7 });
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };

    const r = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: {},
      schema_version: '1.4.1',                                              // v1 payload-schema string (TEXT)
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row.schema_version).toBe('1.4.1');                              // v1 TEXT preserved
    expect(row.registry_schema_version).toBe(7);                           // v2 INTEGER pointer
  });
});
