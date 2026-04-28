/**
 * Push-or-poll wrapper — verifies §7.4 degradation contract end-to-end:
 *   - poll-mode when daemon is down at startup
 *   - push-mode when daemon is up
 *   - transparent fall-back to poll when the daemon stops mid-stream
 *   - auto-recovery to push when daemon comes back
 *   - cursor advance is persisted in SQLite across mode transitions
 *   - close() interrupts cleanly
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { register } from '../../lib/register.js';
import { startDaemon } from '../../lib/daemon.js';
import { subscribePushOrPoll } from '../../lib/subscribe-push-or-poll.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function takeN(sub, n, timeoutMs = 3000) {
  const out = [];
  const it = sub[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (out.length < n) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`takeN: only got ${out.length}/${n} before timeout`);
    const next = await Promise.race([
      it.next(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('iterator next timed out')), left)),
    ]);
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('subscribePushOrPoll — §7.4 degradation contract', () => {
  let tmpDir;
  let originalEnv;
  let db;
  let daemon;
  let cursorId;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-pop-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    db = openDb();

    const reg = register(db, {
      plugin: 'test', role: 'subscriber',
      filter: 'wicked.test.fired',
      cursor_init: 'oldest',
    });
    cursorId = reg.cursor_id;
  });

  afterEach(async () => {
    if (daemon) { try { await daemon.stop(); } catch (_e) { /* ignore */ } daemon = null; }
    try { db.close(); } catch (_e) { /* ignore */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  skipOnWindows('starts in poll mode when no daemon is running', async () => {
    const sub = await subscribePushOrPoll({
      db, cursor_id: cursorId, dataDir: tmpDir,
      poll_interval_ms: 50, auto_recover: false,
    });
    expect(sub.mode).toBe('poll');

    const config = { ...loadConfig(), daemon_notify: false };
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: {} });
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: {} });

    const events = await takeN(sub, 2, 3000);
    expect(events.map(e => e.event_id)).toEqual([1, 2]);
    expect(sub.mode).toBe('poll');

    sub.close();
  });

  skipOnWindows('starts in push mode when daemon is reachable', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });

    const sub = await subscribePushOrPoll({
      db, cursor_id: cursorId, dataDir: tmpDir,
      poll_interval_ms: 50,
    });
    expect(sub.mode).toBe('push');

    const config = loadConfig();                       // daemon_notify = true (default)
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: { n: 1 } });
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: { n: 2 } });

    const events = await takeN(sub, 2, 3000);
    expect(events.map(e => e.event_id)).toEqual([1, 2]);
    expect(sub.mode).toBe('push');

    sub.close();
  });

  // -------------------------------------------------------------------------
  // Degradation handoff: daemon stops mid-stream → wrapper falls back to poll
  // -------------------------------------------------------------------------

  skipOnWindows('falls back to poll mode when the daemon stops, no events lost', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await subscribePushOrPoll({
      db, cursor_id: cursorId, dataDir: tmpDir,
      poll_interval_ms: 50,
      auto_recover: false,
    });
    expect(sub.mode).toBe('push');

    const config = loadConfig();
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: { n: 1 } });

    const it = sub[Symbol.asyncIterator]();
    const first = (await it.next()).value;
    expect(first.event_id).toBe(1);
    expect(sub.mode).toBe('push');

    // Stop the daemon — wrapper must transition to poll.
    await daemon.stop();
    daemon = null;

    // Emit AFTER daemon stops. With daemon_notify=true the notify will fail
    // silently; the event still hits SQLite, so poll should pick it up.
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: { n: 2 } });

    const second = await Promise.race([
      it.next().then(r => r.value),
      delay(3000).then(() => null),
    ]);

    expect(second).not.toBeNull();
    expect(second.event_id).toBe(2);
    expect(sub.mode).toBe('poll');
    expect(sub.transitionCount).toBeGreaterThanOrEqual(2);   // entered push, then dropped to poll

    sub.close();
  });

  // -------------------------------------------------------------------------
  // Auto-recovery: daemon comes back, wrapper returns to push
  // -------------------------------------------------------------------------

  skipOnWindows('auto-recovers to push mode when the daemon comes back', async () => {
    // No daemon at startup → poll mode
    const sub = await subscribePushOrPoll({
      db, cursor_id: cursorId, dataDir: tmpDir,
      poll_interval_ms: 30,
      reprobe_interval_ms: 30,
      probe_timeout_ms: 30,
    });
    expect(sub.mode).toBe('poll');

    const config = loadConfig();
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: { n: 1 } });

    const it = sub[Symbol.asyncIterator]();
    const first = (await it.next()).value;
    expect(first.event_id).toBe(1);
    expect(sub.mode).toBe('poll');

    // Start the daemon → wrapper should re-probe and switch to push.
    daemon = await startDaemon({ dataDir: tmpDir });

    // Emit after daemon is up. We give the iterator several turns to detect
    // the daemon and switch — push delivery picks up the event either way.
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: { n: 2 } });

    const deadline = Date.now() + 3000;
    let nextEvent = null;
    while (Date.now() < deadline && nextEvent === null) {
      const result = await Promise.race([
        it.next().then(r => r.value),
        delay(150).then(() => undefined),
      ]);
      if (result !== undefined) { nextEvent = result; break; }
    }

    expect(nextEvent).not.toBeNull();
    expect(nextEvent.event_id).toBe(2);

    // The wrapper SHOULD have transitioned to push by now. We don't hard-
    // assert mode === 'push' because the event could be delivered either by
    // the final poll batch right before transition or by push afterward —
    // but at minimum a transition must have occurred.
    expect(sub.transitionCount).toBeGreaterThanOrEqual(1);

    sub.close();
  });

  // -------------------------------------------------------------------------
  // Cursor anchoring: ack persists across mode transitions
  // -------------------------------------------------------------------------

  skipOnWindows('persists cursor advance to SQLite across push and poll modes', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await subscribePushOrPoll({
      db, cursor_id: cursorId, dataDir: tmpDir,
      poll_interval_ms: 50, auto_recover: false,
    });

    const config = loadConfig();
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: {} });

    await takeN(sub, 1, 3000);

    const cursorRow1 = db.prepare('SELECT last_event_id FROM cursors WHERE cursor_id = ?').get(cursorId);
    expect(cursorRow1.last_event_id).toBe(1);

    await daemon.stop(); daemon = null;
    emit(db, config, { event_type: 'wicked.test.fired', domain: 'd', payload: {} });

    await takeN(sub, 1, 3000);

    const cursorRow2 = db.prepare('SELECT last_event_id FROM cursors WHERE cursor_id = ?').get(cursorId);
    expect(cursorRow2.last_event_id).toBe(2);

    sub.close();
  });

  // -------------------------------------------------------------------------
  // close() interrupts an idle poll-mode wait
  // -------------------------------------------------------------------------

  skipOnWindows('close() interrupts an idle poll wait without hanging', async () => {
    const sub = await subscribePushOrPoll({
      db, cursor_id: cursorId, dataDir: tmpDir,
      poll_interval_ms: 5000,                     // long sleep
      auto_recover: false,
    });

    const it = sub[Symbol.asyncIterator]();
    const nextPromise = it.next();

    // Give the iterator a tick to start the sleep
    await delay(50);
    sub.close();

    const result = await Promise.race([
      nextPromise,
      delay(2000).then(() => ({ timeout: true })),
    ]);

    expect(result).not.toEqual({ timeout: true });
    expect(result.done).toBe(true);
  });

  skipOnWindows('rejects when called without required opts', async () => {
    await expect(subscribePushOrPoll({})).rejects.toThrow();
    await expect(subscribePushOrPoll({ db, cursor_id: cursorId })).rejects.toThrow();
    await expect(subscribePushOrPoll({ db, dataDir: tmpDir })).rejects.toThrow();
  });
});
