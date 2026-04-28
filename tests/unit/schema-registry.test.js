/**
 * Schema registry tests — applyOnEmit policy modes (warn / cas-auto / strict)
 * and the embedded JSON Schema validator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';
import {
  applyOnEmit,
  validateAgainst,
  getSchema,
} from '../../lib/schema-registry.js';
import { exists as casExists, get as casGet } from '../../lib/cas.js';

// ---------------------------------------------------------------------------

function registerSchema(db, eventType, opts = {}) {
  db.prepare(`
    INSERT INTO schemas (
      event_type, version, json_schema, retention,
      payload_max_bytes, archive_to, payload_oversize
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    opts.version          ?? 1,
    opts.json_schema      ?? '{}',
    opts.retention        ?? 'default',
    opts.payload_max_bytes ?? 16384,
    opts.archive_to       ?? 'warm',
    opts.payload_oversize ?? 'warn',
  );
}

// ---------------------------------------------------------------------------

describe('schema-registry — applyOnEmit', () => {
  let tmpDir;
  let originalEnv;
  let db;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-schema-' + randomUUID());
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

  it('passthrough when no schema is registered (v1 compat)', () => {
    const result = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.unregistered.event',
      payloadStr: '{"hello":"world"}',
    });
    expect(result.payload).toBe('{"hello":"world"}');
    expect(result.payload_cas_sha).toBeNull();
    expect(result.registry_schema_version).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('attaches registry_schema_version when a schema matches', () => {
    registerSchema(db, 'wicked.test.fired', { version: 3 });

    const result = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: '{}',
    });
    expect(result.registry_schema_version).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Size policy: warn / cas-auto / strict
  // -------------------------------------------------------------------------

  it('warn mode: oversize payloads pass through with a logged warning', () => {
    registerSchema(db, 'wicked.test.fired', {
      payload_max_bytes: 16,
      payload_oversize: 'warn',
    });
    const big = JSON.stringify({ data: 'x'.repeat(50) });

    const result = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: big,
    });
    expect(result.payload).toBe(big);
    expect(result.payload_cas_sha).toBeNull();
    expect(result.warnings.some(w => w.includes('WB-008'))).toBe(true);
  });

  it('strict mode: oversize payloads throw WB-008', () => {
    registerSchema(db, 'wicked.test.fired', {
      payload_max_bytes: 16,
      payload_oversize: 'strict',
    });
    const big = JSON.stringify({ data: 'x'.repeat(50) });

    expect(() => applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: big,
    })).toThrow(expect.objectContaining({ error: 'WB-008' }));
  });

  it('cas-auto mode: oversize payloads land in CAS, payload becomes {$cas:sha}', () => {
    registerSchema(db, 'wicked.test.fired', {
      payload_max_bytes: 16,
      payload_oversize: 'cas-auto',
    });
    const big = JSON.stringify({ data: 'x'.repeat(50) });

    const result = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: big,
    });

    expect(result.payload_cas_sha).toMatch(/^[0-9a-f]{64}$/);
    const parsed = JSON.parse(result.payload);
    expect(parsed.$cas).toBe(result.payload_cas_sha);

    // Round-trip through CAS
    expect(casExists(tmpDir, result.payload_cas_sha)).toBe(true);
    const fromCas = casGet(tmpDir, result.payload_cas_sha).toString('utf8');
    expect(fromCas).toBe(big);
  });

  it('cas-auto: small payloads pass through unmodified', () => {
    registerSchema(db, 'wicked.test.fired', {
      payload_max_bytes: 1024,
      payload_oversize: 'cas-auto',
    });
    const small = JSON.stringify({ small: true });

    const result = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: small,
    });
    expect(result.payload).toBe(small);
    expect(result.payload_cas_sha).toBeNull();
  });

  // -------------------------------------------------------------------------
  // JSON Schema validation
  // -------------------------------------------------------------------------

  it('emits WB-009 warning when payload violates the registered schema', () => {
    const jsonSchema = JSON.stringify({
      type: 'object',
      required: ['user_id'],
      properties: { user_id: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    });
    registerSchema(db, 'wicked.test.fired', { json_schema: jsonSchema });

    const r1 = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: '{"user_id":"abc"}',                  // wrong type
    });
    expect(r1.warnings.some(w => w.includes('WB-009'))).toBe(true);

    const r2 = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: '{}',                                  // missing required
    });
    expect(r2.warnings.some(w => w.includes('WB-009'))).toBe(true);
    expect(r2.warnings.join(' ')).toMatch(/missing required property 'user_id'/);

    const r3 = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: '{"user_id":42,"extra":"oops"}',       // additionalProperties:false
    });
    expect(r3.warnings.some(w => w.includes('WB-009'))).toBe(true);
  });

  it('emits no WB-009 warning when payload matches the registered schema', () => {
    registerSchema(db, 'wicked.test.fired', {
      json_schema: JSON.stringify({
        type: 'object',
        properties: { user_id: { type: 'integer' } },
      }),
    });

    const result = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: '{"user_id":42}',
    });
    expect(result.warnings.some(w => w.includes('WB-009'))).toBe(false);
  });

  it('skips JSON Schema validation when the schema is unparseable', () => {
    registerSchema(db, 'wicked.test.fired', {
      json_schema: '{not valid json',
    });

    const result = applyOnEmit({
      db, dataDir: tmpDir,
      eventType: 'wicked.test.fired',
      payloadStr: '{"anything":1}',
    });
    expect(result.warnings.some(w => w.includes('unparseable'))).toBe(true);
    // No WB-009 because validation didn't actually run
    expect(result.warnings.some(w => w.includes('WB-009'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // getSchema helper picks the latest version
  // -------------------------------------------------------------------------

  it('getSchema returns the latest version for an event_type', () => {
    registerSchema(db, 'wicked.test.fired', { version: 1 });
    registerSchema(db, 'wicked.test.fired', { version: 5 });
    registerSchema(db, 'wicked.test.fired', { version: 3 });
    const s = getSchema(db, 'wicked.test.fired');
    expect(s.version).toBe(5);
    expect(getSchema(db, 'wicked.unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('validateAgainst — embedded JSON Schema subset', () => {
  it('checks types', () => {
    expect(validateAgainst({ type: 'string' }, 'hi')).toEqual([]);
    const v = validateAgainst({ type: 'string' }, 42);
    expect(v.join(' ')).toMatch(/expected string, got number/);
  });

  it('treats integer + number correctly', () => {
    expect(validateAgainst({ type: 'integer' }, 42)).toEqual([]);
    expect(validateAgainst({ type: 'integer' }, 4.2)[0]).toMatch(/expected integer/);
  });

  it('checks required fields', () => {
    const v = validateAgainst({ required: ['a', 'b'] }, { a: 1 });
    expect(v.join(' ')).toMatch(/missing required property 'b'/);
  });

  it('checks enum membership', () => {
    expect(validateAgainst({ enum: ['x', 'y'] }, 'x')).toEqual([]);
    expect(validateAgainst({ enum: ['x', 'y'] }, 'z')[0]).toMatch(/not in enum/);
  });

  it('checks additionalProperties:false', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'integer' } },
      additionalProperties: false,
    };
    expect(validateAgainst(schema, { a: 1 })).toEqual([]);
    expect(validateAgainst(schema, { a: 1, b: 2 })[0]).toMatch(/additional property 'b'/);
  });

  it('recurses into nested properties + items', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    };
    expect(validateAgainst(schema, { tags: ['ok', 'fine'] })).toEqual([]);
    const v = validateAgainst(schema, { tags: ['ok', 42] });
    expect(v[0]).toMatch(/tags\[1\]/);
    expect(v[0]).toMatch(/expected string/);
  });

  it('checks string length and number range', () => {
    expect(validateAgainst({ type: 'string', minLength: 3 }, 'ab')[0]).toMatch(/minLength/);
    expect(validateAgainst({ type: 'string', maxLength: 3 }, 'abcd')[0]).toMatch(/maxLength/);
    expect(validateAgainst({ type: 'number', minimum: 10 }, 5)[0]).toMatch(/minimum/);
    expect(validateAgainst({ type: 'number', maximum: 10 }, 15)[0]).toMatch(/maximum/);
  });
});
