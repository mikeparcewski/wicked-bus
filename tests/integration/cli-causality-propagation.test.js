/**
 * §14.3 I10 — cross-process causality propagation.
 * Verifies the env-var contract: when a parent process emits inside a
 * withContext() block and spawns a child with `causalityEnv()` merged in,
 * the child's emit() inherits the same correlation_id and chains via
 * parent_event_id.
 *
 * The "parent" here is the test runner itself (we use the in-process emit()
 * + withContext() wrapper to seed event 1). The "child" is a real subprocess
 * invoking the CLI with the WICKED_BUS_* env vars set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from '../cli/helpers.js';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import {
  withContext,
  causalityEnv,
  CAUSALITY_ENV_KEYS,
} from '../../lib/causality.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

describe('§14.3 I10 — cross-process causality propagation', () => {
  let tmpDir;
  let db;
  let originalEnv;

  beforeEach(() => {
    originalEnv = {};
    for (const k of Object.values(CAUSALITY_ENV_KEYS)) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
    tmpDir = join(tmpdir(), 'wb-i10-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    writeDefaultConfig(tmpDir);
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    db = openDb();
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* ignore */ }
    delete process.env.WICKED_BUS_DATA_DIR;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  skipOnWindows('child CLI emit inherits correlation_id and parent_event_id from env', () => {
    const correlationId = 'req-' + randomUUID();
    const sessionId     = 'sess-' + randomUUID();

    // Parent emits event 1 inside a withContext block.
    const parentResult = withContext(
      { correlation_id: correlationId, session_id: sessionId, producer_id: 'parent-proc' },
      () => emit(db, { ...loadConfig(), daemon_notify: false, log_level: 'silent' }, {
        event_type: 'wicked.test.fired',
        domain: 'd',
        payload: { tier: 'parent' },
      }),
    );

    // Build the env block the parent would attach to spawn().
    const env = withContext(
      {
        correlation_id: correlationId,
        session_id: sessionId,
        parent_event_id: parentResult.event_id,
        producer_id: 'parent-proc',
      },
      () => causalityEnv(),
    );

    // Spawn the CLI as the "child" with that env.
    const childResult = run(
      [
        'emit',
        '--type', 'wicked.test.fired',
        '--domain', 'd',
        '--payload', JSON.stringify({ tier: 'child' }),
      ],
      { dataDir: tmpDir, env },
    );
    expect(childResult.exitCode).toBe(0);
    const childEmit = JSON.parse(childResult.stdout);

    // Re-open the DB and verify the child row inherited everything.
    const db2 = openDb();
    const row = db2.prepare('SELECT * FROM events WHERE event_id = ?').get(childEmit.event_id);
    db2.close();

    expect(row.correlation_id).toBe(correlationId);
    expect(row.session_id).toBe(sessionId);
    expect(row.parent_event_id).toBe(parentResult.event_id);
    expect(row.producer_id).toBe('parent-proc');
  });

  skipOnWindows('child CLI emit without env vars writes NULL causality (v1 compat)', () => {
    const result = run(
      [
        'emit',
        '--type', 'wicked.test.fired',
        '--domain', 'd',
        '--payload', JSON.stringify({}),
      ],
      { dataDir: tmpDir, env: {} /* no causality env */ },
    );
    expect(result.exitCode).toBe(0);
    const r = JSON.parse(result.stdout);

    const db2 = openDb();
    const row = db2.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    db2.close();

    expect(row.correlation_id).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.parent_event_id).toBeNull();
    expect(row.producer_id).toBeNull();
  });
});
