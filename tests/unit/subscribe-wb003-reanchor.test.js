/**
 * WB-003 CURSOR_BEHIND_TTL_WINDOW — the poll loop re-anchors instead of wedging (wicked-crew #445).
 *
 * Before 2.3.5 a subscriber whose cursor fell behind the TTL sweep re-polled the same position on
 * every tick, forever: the swept rows were gone, the same WB-003 fired each tick, and nothing that
 * survived the sweep was ever delivered again (crew's seven subscribers; the document "working" veil
 * that never resolved). subscribe() is the one place holding both the handle and the cursor, so it
 * must:
 *
 *   - re-anchor the durable cursor to `MIN(event_id) - 1` (the oldest SURVIVING event, never the
 *     head) and deliver everything the sweep left on the next tick,
 *   - report WB-003 ONCE per subscriber per sweep, with `reanchored_to` and `swept_past`, and never
 *     repeat it on the following ticks,
 *   - treat a filtered subscriber that matched nothing the same way (cursors advance only on ack,
 *     so it sits behind the sweep having lost nothing),
 *   - report a FAILING re-anchor write (SQLITE_BUSY) as its own error and keep ticking — never an
 *     unhandled rejection — then re-anchor once the write succeeds.
 *
 * The sweep is stood in for by deleting the oldest rows through a second better-sqlite3 handle on
 * the same file — the shape a `cleanup` in another process has.
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

/** A real db whose prepare() throws SQLITE_BUSY for statements matching `fault.sql` while set. */
function faultable(db) {
  const fault = { sql: null };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare' && fault.sql !== null) {
        return (sql) => {
          if (fault.sql.test(sql)) {
            const err = new Error('database is locked');
            err.code = 'SQLITE_BUSY';
            throw err;
          }
          return target.prepare(sql);
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, fault };
}

function emitN(db, config, n, type = 'wicked.test.a') {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(emit(db, config, { event_type: type, domain: 'test', subdomain: 'x', payload: { i } }).event_id);
  }
  return ids;
}

function cursorPosition(db, plugin) {
  return db.prepare(`
    SELECT c.last_event_id FROM cursors c
    INNER JOIN subscriptions s ON s.subscription_id = c.subscription_id
    WHERE s.plugin = ? AND c.deregistered_at IS NULL
  `).get(plugin).last_event_id;
}

/** Stand in for the TTL sweep: remove every row at or below `throughEventId` from OUTSIDE. */
function sweepThrough(config, throughEventId) {
  const other = openDb(config);
  try {
    other.prepare('DELETE FROM events WHERE event_id <= ?').run(throughEventId);
  } finally {
    other.close();
  }
}

describe('subscribe — WB-003 re-anchors to the oldest surviving event', () => {
  let db, config, tmpDir, originalEnv, subs;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-reanchor-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = loadConfig();
    db = openDb(config);
    subs = [];
  });

  afterEach(async () => {
    for (const s of subs) { try { await s.stop(); } catch (_) { /* already stopped */ } }
    try { db.close(); } catch (_) { /* already closed */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  it('reports WB-003 once per subscriber with reanchored_to/swept_past, moves both cursors to MIN-1, and resumes delivery', async () => {
    // Five events exist when the two subscribers register at `latest` (last_event_id = 5).
    const before = emitN(db, config, 5);
    expect(before).toEqual([1, 2, 3, 4, 5]);

    const matchingErrors = [];
    const matchingReceived = [];
    const matching = subscribe({
      db,
      plugin: 'matching',
      filter: 'wicked.test.*',
      handler: (e) => { matchingReceived.push(e.event_id); },
      onError: (err) => { matchingErrors.push(err); },
      pollIntervalMs: 20,
    });
    subs.push(matching);

    // A subscriber whose filter matches NOTHING: its cursor never advances (advance = ack), so
    // it sits behind the sweep too — having lost nothing.
    const idleErrors = [];
    const idleReceived = [];
    const idle = subscribe({
      db,
      plugin: 'idle',
      filter: 'wicked.never.*',
      handler: (e) => { idleReceived.push(e.event_id); },
      onError: (err) => { idleErrors.push(err); },
      pollIntervalMs: 20,
    });
    subs.push(idle);

    // Let both loops tick clean at least once, then stop them from moving before the sweep: five
    // more events land (6..10) and the "sweep" removes 1..8 from outside while both cursors still
    // read 5 — the matching subscriber is deliberately kept from acking 6..8 by stopping first.
    await wait(60);
    await matching.stop();
    await idle.stop();
    subs.length = 0;
    expect(cursorPosition(db, 'matching')).toBe(5);
    expect(cursorPosition(db, 'idle')).toBe(5);

    emitN(db, config, 5);
    sweepThrough(config, 8);
    expect(db.prepare('SELECT MIN(event_id) AS m FROM events').get().m).toBe(9);

    // Resume both (same plugin + filter → the same cursors) and let them hit the sweep.
    const matching2 = subscribe({
      db,
      plugin: 'matching',
      filter: 'wicked.test.*',
      handler: (e) => { matchingReceived.push(e.event_id); },
      onError: (err) => { matchingErrors.push(err); },
      pollIntervalMs: 20,
    });
    const idle2 = subscribe({
      db,
      plugin: 'idle',
      filter: 'wicked.never.*',
      handler: (e) => { idleReceived.push(e.event_id); },
      onError: (err) => { idleErrors.push(err); },
      pollIntervalMs: 20,
    });
    subs.push(matching2, idle2);

    await waitFor(() => matchingErrors.length >= 1 && idleErrors.length >= 1);

    for (const errors of [matchingErrors, idleErrors]) {
      expect(errors[0]).toBeInstanceOf(WBError);
      expect(errors[0].error).toBe('WB-003');
      expect(errors[0].context.cursor_last_event_id).toBe(5);
      expect(errors[0].context.oldest_available_event_id).toBe(9);
      expect(errors[0].context.reanchored_to).toBe(8);
      expect(errors[0].context.swept_past).toEqual([6, 8]);
      expect(errors[0].context.remediation).toMatch(/oldest surviving event/);
    }
    expect(cursorPosition(db, 'matching')).toBe(8);
    expect(cursorPosition(db, 'idle')).toBe(8);

    // Delivery resumes from the oldest SURVIVING event (9), never the head: 9 and 10 arrive, then
    // a fresh emit is consumed too.
    await waitFor(() => matchingReceived.length >= 2);
    expect(matchingReceived).toEqual([9, 10]);
    const [fresh] = emitN(db, config, 1);
    await waitFor(() => matchingReceived.includes(fresh));
    expect(cursorPosition(db, 'matching')).toBe(fresh);

    // Several more ticks: no repeat of WB-003 on either handle; the idle one still received nothing.
    await wait(120);
    expect(matchingErrors).toHaveLength(1);
    expect(idleErrors).toHaveLength(1);
    expect(idleReceived).toEqual([]);
  });

  it('a failing re-anchor write reaches onError as its own error, the loop keeps ticking, and it re-anchors once the write succeeds', async () => {
    emitN(db, config, 3);
    const { proxy, fault } = faultable(db);
    const errors = [];
    const received = [];
    const rejections = [];
    const onUnhandled = (reason) => { rejections.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const first = subscribe({
        db: proxy,
        plugin: 'busy',
        filter: 'wicked.test.*',
        handler: (e) => { received.push(e.event_id); },
        onError: (err) => { errors.push(err); },
        pollIntervalMs: 20,
      });
      subs.push(first);
      await wait(60);
      await first.stop();
      subs.length = 0;
      expect(cursorPosition(db, 'busy')).toBe(3);

      emitN(db, config, 3); // 4..6
      sweepThrough(config, 5); // MIN = 6; cursor 3 < 5 → WB-003

      // Only the re-anchor UPDATE is locked; the poll's SELECTs go through.
      fault.sql = /UPDATE cursors/;
      const sub = subscribe({
        db: proxy,
        plugin: 'busy',
        filter: 'wicked.test.*',
        handler: (e) => { received.push(e.event_id); },
        onError: (err) => { errors.push(err); },
        pollIntervalMs: 20,
      });
      subs.push(sub);

      // The write failure is reported as ITSELF (not dressed as WB-003), at least twice — the
      // loop kept ticking and retried — and the cursor has not moved.
      await waitFor(() => errors.filter(e => e.code === 'SQLITE_BUSY').length >= 2);
      expect(errors.some(e => e instanceof WBError && e.error === 'WB-003')).toBe(false);
      expect(cursorPosition(db, 'busy')).toBe(3);

      // Lock released: the next tick re-anchors, reports WB-003 once, and delivers the survivor.
      fault.sql = null;
      await waitFor(() => errors.some(e => e instanceof WBError && e.error === 'WB-003'));
      const wb003 = errors.filter(e => e instanceof WBError && e.error === 'WB-003');
      expect(wb003).toHaveLength(1);
      expect(wb003[0].context.reanchored_to).toBe(5);
      expect(wb003[0].context.swept_past).toEqual([4, 5]);
      await waitFor(() => received.includes(6));
      expect(cursorPosition(db, 'busy')).toBe(6);

      await wait(80);
      expect(errors.filter(e => e instanceof WBError && e.error === 'WB-003')).toHaveLength(1);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
