/**
 * WB-014 SUBSCRIBER_DB_UNUSABLE — the poll loop names a dead connection (wicked-crew F-E2E-021).
 *
 * When poll() fails with a SQLite result that means THIS handle's view of the database is gone for
 * good (SQLITE_CORRUPT / SQLITE_NOTADB / SQLITE_IOERR*), subscribe() must deliver a WBError WB-014
 * to onError with the sqlite code and a consecutive counter, expose it on getHealth(), keep the
 * cadence, pass every other poll error through unchanged, and reset once a poll succeeds again.
 *
 * The connection is driven through a Proxy so the failure is injected where the daemon saw it — the
 * poll tick's first prepare() (the replay drain, then poll()) — on a REAL better-sqlite3 handle
 * (registration ran on the real thing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { subscribe } from '../../lib/subscribe.js';
import { WBError } from '../../lib/errors.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await wait(5);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** A real db whose prepare() throws the injected SQLite error while `fault.code` is set. */
function faultable(db) {
  const fault = { code: null, message: 'database disk image is malformed' };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare' && fault.code !== null) {
        return () => {
          const err = new Error(fault.message);
          err.code = fault.code;
          throw err;
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, fault };
}

describe('subscribe — WB-014 SUBSCRIBER_DB_UNUSABLE', () => {
  let db, config, tmpDir, originalEnv, sub;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-unusable-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = loadConfig();
    db = openDb(config);
    sub = null;
  });

  afterEach(async () => {
    if (sub) { try { await sub.stop(); } catch (_) { /* already stopped */ } }
    try { db.close(); } catch (_) { /* already closed */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  it('delivers WB-014 with the sqlite code and a consecutive counter, exposes it on getHealth(), and resets on recovery', async () => {
    const { proxy, fault } = faultable(db);
    const errors = [];
    const received = [];
    sub = subscribe({
      db: proxy,
      plugin: 'unusable-test',
      filter: 'wicked.test.**',
      pollIntervalMs: 10,
      handler: (ev) => { received.push(ev.event_id); },
      onError: (err) => { errors.push(err); },
    });
    expect(sub.getHealth()).toEqual({ unusable: false, consecutive_unusable_polls: 0, last_unusable_poll: null });

    // The handle's view of the db goes bad exactly where the daemon saw it: the poll's prepare().
    fault.code = 'SQLITE_CORRUPT';
    await waitFor(() => errors.length >= 3);

    for (const [i, err] of errors.slice(0, 3).entries()) {
      expect(err).toBeInstanceOf(WBError);
      expect(err.error).toBe('WB-014');
      expect(err.code).toBe('SUBSCRIBER_DB_UNUSABLE');
      expect(err.context.sqlite_code).toBe('SQLITE_CORRUPT');
      expect(err.context.sqlite_message).toBe('database disk image is malformed');
      expect(err.context.consecutive).toBe(i + 1);
      expect(err.context.plugin).toBe('unusable-test');
      expect(err.context.subscription_id).toBe(sub.subscription_id);
      expect(err.context.cursor_id).toBe(sub.cursor_id);
      expect(err.context.db_path).toBe(db.name);
      expect(err.message).toMatch(/cannot read the bus db \(SQLITE_CORRUPT: database disk image is malformed\)/);
      expect(err.message).toMatch(/exit this process WITHOUT closing its bus connections, then restart it/);
      expect(err.message).not.toMatch(/reopen the connection/);
      expect(err.context.remediation).toBe('exit this process WITHOUT closing its bus connections, then restart it');
    }
    const health = sub.getHealth();
    expect(health.unusable).toBe(true);
    expect(health.consecutive_unusable_polls).toBeGreaterThanOrEqual(3);
    expect(health.last_unusable_poll).toMatchObject({ sqlite_code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' });
    expect(typeof health.last_unusable_poll.at).toBe('number');

    // The connection comes back (the owner reopened / the fault clears): the next successful poll
    // resets the WB-014 state and delivery resumes.
    fault.code = null;
    emit(db, config, { event_type: 'wicked.test.after.recovery', domain: 'test', subdomain: 'x', payload: { ok: true } });
    await waitFor(() => received.length === 1);
    expect(sub.getHealth()).toEqual({ unusable: false, consecutive_unusable_polls: 0, last_unusable_poll: null });
  });

  it('classifies SQLITE_NOTADB and SQLITE_IOERR_* as unusable too', async () => {
    for (const code of ['SQLITE_NOTADB', 'SQLITE_IOERR_READ']) {
      const { proxy, fault } = faultable(db);
      const errors = [];
      const handle = subscribe({
        db: proxy, plugin: `unusable-${code}`, filter: 'wicked.test.**', pollIntervalMs: 10,
        handler: () => {}, onError: (err) => { errors.push(err); },
      });
      fault.code = code;
      await waitFor(() => errors.length >= 1);
      expect(errors[0].error).toBe('WB-014');
      expect(errors[0].context.sqlite_code).toBe(code);
      expect(handle.getHealth().unusable).toBe(true);
      fault.code = null;
      await handle.stop();
    }
  });

  it('passes every other poll error through unchanged and does not mark the handle unusable', async () => {
    const { proxy, fault } = faultable(db);
    const errors = [];
    sub = subscribe({
      db: proxy, plugin: 'busy-test', filter: 'wicked.test.**', pollIntervalMs: 10,
      handler: () => {}, onError: (err) => { errors.push(err); },
    });
    fault.code = 'SQLITE_BUSY';
    fault.message = 'database is locked';
    await waitFor(() => errors.length >= 2);
    expect(errors[0]).not.toBeInstanceOf(WBError);
    expect(errors[0].code).toBe('SQLITE_BUSY');
    expect(errors[0].message).toBe('database is locked');
    expect(sub.getHealth()).toEqual({ unusable: false, consecutive_unusable_polls: 0, last_unusable_poll: null });
    fault.code = null;
  });
});
