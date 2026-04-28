/**
 * Daemon client tests — probeDaemon (success/miss), connectAsSubscriber
 * async iteration, ack-driven cursor advance, degrade-frame ends iterator,
 * caller-initiated close.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../../lib/daemon.js';
import { probeDaemon, connectAsSubscriber } from '../../lib/daemon-client.js';
import { notifyEmit } from '../../lib/daemon-notify.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

describe('daemon-client (subscriber side)', () => {
  let tmpDir;
  let daemon;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-client-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (daemon) {
      try { await daemon.stop(); } catch (_e) { /* already closed */ }
      daemon = null;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  skipOnWindows('probeDaemon returns false within timeout when no daemon is running', async () => {
    const t0 = Date.now();
    const ok = await probeDaemon(tmpDir, 100);
    const elapsed = Date.now() - t0;
    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });

  skipOnWindows('probeDaemon returns true when the daemon is up', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const ok = await probeDaemon(tmpDir, 100);
    expect(ok).toBe(true);
  });

  // -------------------------------------------------------------------------

  skipOnWindows('connectAsSubscriber yields notifies via async iteration', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-1',
      cursor: 0,
    });

    // Producer side
    notifyEmit(tmpDir, {
      event_id: 1, event_type: 'wicked.test.fired', domain: 'd', subdomain: '', payload: '{}',
    });
    notifyEmit(tmpDir, {
      event_id: 2, event_type: 'wicked.test.fired', domain: 'd', subdomain: '', payload: '{}',
    });

    const seen = [];
    const iterator = sub[Symbol.asyncIterator]();
    seen.push((await iterator.next()).value.event_id);
    seen.push((await iterator.next()).value.event_id);

    expect(seen).toEqual([1, 2]);
    sub.close();
  });

  skipOnWindows('ack(event_id) advances the daemon-side cursor', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });

    const ackFired = new Promise(res => daemon.once('ack', res));

    const sub = await connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-2',
      cursor: 0,
    });

    notifyEmit(tmpDir, {
      event_id: 5, event_type: 't', domain: 'd', subdomain: '', payload: '{}',
    });

    const it = sub[Symbol.asyncIterator]();
    const frame = (await it.next()).value;
    expect(frame.event_id).toBe(5);

    sub.ack(5);
    const ack = await ackFired;
    expect(ack.event_id).toBe(5);

    sub.close();
  });

  skipOnWindows('ping/pong round-trip works while connected', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-3',
      cursor: 0,
    });
    const ok = await sub.ping();
    expect(ok).toBe(true);
    sub.close();
  });

  // -------------------------------------------------------------------------

  skipOnWindows('iterator ends with done:true when the daemon stops (degrade-shutdown)', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-4',
      cursor: 0,
    });

    const it = sub[Symbol.asyncIterator]();
    const nextPromise = it.next();

    await daemon.stop();
    daemon = null;

    const result = await nextPromise;
    expect(result.done).toBe(true);
    expect(sub.degraded).not.toBeNull();
    expect(sub.degraded.reason).toBe('daemon-shutdown');
    expect(sub.isClosed).toBe(true);
  });

  skipOnWindows('connectAsSubscriber rejects when the daemon is unreachable', async () => {
    await expect(connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-5',
      cursor: 0,
      connect_timeout_ms: 50,
    })).rejects.toThrow();
  });

  skipOnWindows('caller-initiated close ends the iterator cleanly', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-6',
      cursor: 0,
    });

    const it = sub[Symbol.asyncIterator]();
    const nextPromise = it.next();

    sub.close();
    const result = await nextPromise;
    expect(result.done).toBe(true);
    expect(sub.isClosed).toBe(true);
  });

  skipOnWindows('cursor argument suppresses delivery of already-seen event_ids', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-7',
      cursor: 100,                                      // already past 100
    });

    notifyEmit(tmpDir, { event_id: 100, event_type: 't', domain: 'd', subdomain: '', payload: '{}' });
    notifyEmit(tmpDir, { event_id: 101, event_type: 't', domain: 'd', subdomain: '', payload: '{}' });

    const it = sub[Symbol.asyncIterator]();
    const frame = (await it.next()).value;
    expect(frame.event_id).toBe(101);                   // 100 was suppressed

    sub.close();
  });

  skipOnWindows('filter scopes which events the subscriber receives', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const sub = await connectAsSubscriber({
      dataDir: tmpDir,
      subscriber_id: 'sub-8',
      cursor: 0,
      filter: { event_type: 'wicked.match.this' },
    });

    notifyEmit(tmpDir, { event_id: 1, event_type: 'wicked.skip.me',    domain: 'd', subdomain: '', payload: '{}' });
    notifyEmit(tmpDir, { event_id: 2, event_type: 'wicked.match.this', domain: 'd', subdomain: '', payload: '{}' });

    const it = sub[Symbol.asyncIterator]();
    const frame = (await it.next()).value;
    expect(frame.event_id).toBe(2);

    sub.close();
  });
});
