/**
 * Causality propagation tests — withContext, currentContext, recordEmit,
 * causalityEnv, env-var fallback, and the chain-via-parent_event_id behavior
 * end-to-end through emit().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import {
  withContext,
  currentContext,
  causalityEnv,
  recordEmit,
  CAUSALITY_ENV_KEYS,
} from '../../lib/causality.js';

// ---------------------------------------------------------------------------

describe('causality — withContext / currentContext / causalityEnv', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = {};
    for (const k of Object.values(CAUSALITY_ENV_KEYS)) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('currentContext returns {} when nothing is active', () => {
    expect(currentContext()).toEqual({});
  });

  it('withContext makes fields visible to currentContext inside the body', () => {
    const seen = withContext(
      { correlation_id: 'cor-1', session_id: 'sess-1', producer_id: 'p-1' },
      () => currentContext(),
    );
    expect(seen.correlation_id).toBe('cor-1');
    expect(seen.session_id).toBe('sess-1');
    expect(seen.producer_id).toBe('p-1');
  });

  it('nested withContext inherits-and-overrides per field (last write wins)', () => {
    const seen = withContext({ correlation_id: 'outer', session_id: 's' }, () => {
      return withContext({ correlation_id: 'inner' }, () => currentContext());
    });
    expect(seen.correlation_id).toBe('inner');                           // override
    expect(seen.session_id).toBe('s');                                   // inherited
  });

  it('causalityEnv returns env keys for fields that are set', () => {
    const env = withContext(
      { correlation_id: 'X', session_id: 'Y', producer_id: 'Z' },
      () => causalityEnv(),
    );
    expect(env[CAUSALITY_ENV_KEYS.correlation_id]).toBe('X');
    expect(env[CAUSALITY_ENV_KEYS.session_id]).toBe('Y');
    expect(env[CAUSALITY_ENV_KEYS.producer_id]).toBe('Z');
  });

  it('causalityEnv returns {} when no context is active', () => {
    expect(causalityEnv()).toEqual({});
  });

  it('reads from env vars when no withContext frame is present', () => {
    process.env[CAUSALITY_ENV_KEYS.correlation_id] = 'from-env';
    process.env[CAUSALITY_ENV_KEYS.parent_event_id] = '42';
    expect(currentContext()).toEqual({
      correlation_id: 'from-env',
      session_id: null,
      parent_event_id: 42,
      producer_id: null,
    });
  });

  it('rejects non-positive parent_event_id values silently', () => {
    const seen = withContext({ parent_event_id: -1 }, () => currentContext());
    expect(seen.parent_event_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('causality × emit — chain by parent_event_id', () => {
  let tmpDir;
  let originalEnvDir;
  let envBackup;
  let db;

  beforeEach(() => {
    originalEnvDir = process.env.WICKED_BUS_DATA_DIR;
    envBackup = {};
    for (const k of Object.values(CAUSALITY_ENV_KEYS)) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }

    tmpDir = join(tmpdir(), 'wb-causality-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    db = openDb();
  });

  afterEach(() => {
    try { db.close(); } catch (_e) { /* ignore */ }
    if (originalEnvDir) process.env.WICKED_BUS_DATA_DIR = originalEnvDir;
    else delete process.env.WICKED_BUS_DATA_DIR;
    for (const [k, v] of Object.entries(envBackup)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  it('emit() persists correlation_id, session_id, producer_id from withContext', () => {
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };

    const r = withContext(
      { correlation_id: 'req-x', session_id: 'sess-1', producer_id: 'agent-A' },
      () => emit(db, config, {
        event_type: 'wicked.test.fired',
        domain: 'd',
        payload: {},
      }),
    );

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row.correlation_id).toBe('req-x');
    expect(row.session_id).toBe('sess-1');
    expect(row.producer_id).toBe('agent-A');
    expect(row.parent_event_id).toBeNull();                         // first emit, no parent
  });

  it('successive emits in the same withContext chain via parent_event_id', () => {
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };

    const ids = withContext({ correlation_id: 'cor-chain' }, () => {
      const a = emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: {} });
      const b = emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: {} });
      const c = emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: {} });
      return [a.event_id, b.event_id, c.event_id];
    });

    const rows = db.prepare(
      'SELECT * FROM events WHERE event_id IN (?, ?, ?) ORDER BY event_id ASC',
    ).all(...ids);

    expect(rows[0].parent_event_id).toBeNull();
    expect(rows[1].parent_event_id).toBe(rows[0].event_id);
    expect(rows[2].parent_event_id).toBe(rows[1].event_id);
    for (const r of rows) expect(r.correlation_id).toBe('cor-chain');
  });

  it('explicit fields on the event override the active context', () => {
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };

    const r = withContext({ correlation_id: 'ctx-cor' }, () => emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: {},
      correlation_id: 'event-cor',
    }));

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row.correlation_id).toBe('event-cor');
  });

  it('env-var fallback reaches emit() when no withContext is active', () => {
    process.env[CAUSALITY_ENV_KEYS.correlation_id] = 'env-cor';
    process.env[CAUSALITY_ENV_KEYS.session_id]     = 'env-sess';

    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    const r = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'd',
      payload: {},
    });

    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(r.event_id);
    expect(row.correlation_id).toBe('env-cor');
    expect(row.session_id).toBe('env-sess');
  });

  it('recordEmit advances parent_event_id externally (used internally by emit)', () => {
    const seen = withContext({ correlation_id: 'cor-x' }, () => {
      recordEmit(123);
      return currentContext();
    });
    expect(seen.parent_event_id).toBe(123);
  });

  it('contexts do not leak across withContext blocks', () => {
    withContext({ correlation_id: 'first' }, () => {});
    expect(currentContext()).toEqual({});
  });
});
