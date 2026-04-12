import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { WBError } from '../../lib/errors.js';

describe('emit', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-emit-test-' + randomUUID());
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

  const validEvent = {
    event_type: 'wicked.test.run.completed',
    domain: 'wicked-testing',
    payload: { runId: 'abc', status: 'passed' },
  };

  it('returns event_id and idempotency_key', () => {
    const result = emit(db, config, validEvent);
    expect(result.event_id).toBe(1);
    expect(result.idempotency_key).toBeTruthy();
    expect(result.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('auto-generates UUID v4 idempotency_key', () => {
    const result = emit(db, config, validEvent);
    expect(result.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses provided idempotency_key', () => {
    const key = randomUUID();
    const result = emit(db, config, { ...validEvent, idempotency_key: key });
    expect(result.idempotency_key).toBe(key);
  });

  it('sets emitted_at to Date.now()', () => {
    const before = Date.now();
    emit(db, config, validEvent);
    const after = Date.now();
    const row = db.prepare('SELECT emitted_at FROM events WHERE event_id = 1').get();
    expect(row.emitted_at).toBeGreaterThanOrEqual(before);
    expect(row.emitted_at).toBeLessThanOrEqual(after);
  });

  it('computes expires_at from ttl_hours', () => {
    emit(db, config, validEvent);
    const row = db.prepare('SELECT emitted_at, expires_at FROM events WHERE event_id = 1').get();
    expect(row.expires_at).toBe(row.emitted_at + (72 * 3_600_000));
  });

  it('computes dedup_expires_at from dedup_ttl_hours', () => {
    emit(db, config, validEvent);
    const row = db.prepare('SELECT emitted_at, dedup_expires_at FROM events WHERE event_id = 1').get();
    expect(row.dedup_expires_at).toBe(row.emitted_at + (24 * 3_600_000));
  });

  it('supports per-event ttl_hours override', () => {
    emit(db, config, { ...validEvent, ttl_hours: 10 });
    const row = db.prepare('SELECT emitted_at, expires_at FROM events WHERE event_id = 1').get();
    expect(row.expires_at).toBe(row.emitted_at + (10 * 3_600_000));
  });

  it('throws WB-002 on duplicate idempotency_key', () => {
    const key = randomUUID();
    emit(db, config, { ...validEvent, idempotency_key: key });
    try {
      emit(db, config, { ...validEvent, idempotency_key: key });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WBError);
      expect(err.error).toBe('WB-002');
      expect(err.context.original_event_id).toBe(1);
      expect(err.context.idempotency_key).toBe(key);
    }
  });

  it('does not write a new row on duplicate', () => {
    const key = randomUUID();
    emit(db, config, { ...validEvent, idempotency_key: key });
    try { emit(db, config, { ...validEvent, idempotency_key: key }); } catch (_) {}
    const count = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    expect(count).toBe(1);
  });

  it('stores payload as JSON string', () => {
    emit(db, config, validEvent);
    const row = db.prepare('SELECT payload FROM events WHERE event_id = 1').get();
    const parsed = JSON.parse(row.payload);
    expect(parsed.runId).toBe('abc');
  });

  it('stores metadata when provided', () => {
    emit(db, config, { ...validEvent, metadata: { host: 'test-host' } });
    const row = db.prepare('SELECT metadata FROM events WHERE event_id = 1').get();
    const parsed = JSON.parse(row.metadata);
    expect(parsed.host).toBe('test-host');
  });

  it('stores null metadata when not provided', () => {
    emit(db, config, validEvent);
    const row = db.prepare('SELECT metadata FROM events WHERE event_id = 1').get();
    expect(row.metadata).toBeNull();
  });

  it('defaults schema_version to 1.0.0', () => {
    emit(db, config, validEvent);
    const row = db.prepare('SELECT schema_version FROM events WHERE event_id = 1').get();
    expect(row.schema_version).toBe('1.0.0');
  });
});
