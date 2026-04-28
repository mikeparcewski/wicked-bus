/**
 * §14.3 I9 — schema-registry `cas-auto` offload through the real CLI.
 * Verifies the full path: `wicked-bus emit` → emit() → applyOnEmit cas-auto →
 *   CAS write → live INSERT with `payload_cas_sha` populated and inline payload
 *   rewritten to `{"$cas":"<sha>"}` → row queryable from a fresh DB connection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from '../cli/helpers.js';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig } from '../../lib/config.js';
import { exists as casExists, get as casGet } from '../../lib/cas.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

describe('§14.3 I9 — schema-registry cas-auto offload through CLI emit', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-i9-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    writeDefaultConfig(tmpDir);
    db = openDb({ db_path: join(tmpDir, 'bus.db') });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;

    // Register a schema with a tiny payload cap and cas-auto offload.
    db.prepare(`
      INSERT INTO schemas (
        event_type, version, json_schema, retention,
        payload_max_bytes, archive_to, payload_oversize
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'wicked.test.fired', 1, JSON.stringify({ type: 'object' }),
      'default', 32, 'warm', 'cas-auto',
    );
    db.close();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    delete process.env.WICKED_BUS_DATA_DIR;
  });

  // -------------------------------------------------------------------------

  skipOnWindows('emits a large payload via CLI; row stores {$cas:sha} + payload_cas_sha; CAS round-trips', () => {
    const big = JSON.stringify({ data: 'x'.repeat(200) });

    const result = run(
      [
        'emit',
        '--type', 'wicked.test.fired',
        '--domain', 'd',
        '--payload', big,
      ],
      { dataDir: tmpDir },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(typeof out.event_id).toBe('number');

    // Re-open the DB from outside the CLI's process and verify the row
    const db2 = openDb({ db_path: join(tmpDir, 'bus.db') });
    const row = db2.prepare('SELECT * FROM events WHERE event_id = ?').get(out.event_id);
    db2.close();

    expect(row.payload_cas_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(row.payload)).toEqual({ $cas: row.payload_cas_sha });

    // CAS round-trip
    expect(casExists(tmpDir, row.payload_cas_sha)).toBe(true);
    const recovered = casGet(tmpDir, row.payload_cas_sha).toString('utf8');
    expect(recovered).toBe(big);
  });

  skipOnWindows('emits a small payload via CLI; no offload, no payload_cas_sha', () => {
    const small = JSON.stringify({ ok: 1 });

    const result = run(
      [
        'emit',
        '--type', 'wicked.test.fired',
        '--domain', 'd',
        '--payload', small,
      ],
      { dataDir: tmpDir },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);

    const db2 = openDb({ db_path: join(tmpDir, 'bus.db') });
    const row = db2.prepare('SELECT * FROM events WHERE event_id = ?').get(out.event_id);
    db2.close();

    expect(row.payload_cas_sha).toBeNull();
    expect(JSON.parse(row.payload)).toEqual({ ok: 1 });
  });
});
