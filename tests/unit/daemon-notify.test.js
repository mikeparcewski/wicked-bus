/**
 * End-to-end tests for the producer → daemon → subscriber path:
 *   - notifyEmit() sends a `produced` frame
 *   - daemon receives it and broadcasts to connected subscribers
 *   - notifyEmit() never throws, even when the daemon is down
 *
 * Skipped on Windows (Unix socket only in this spike).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import net from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../../lib/daemon.js';
import { notifyEmit } from '../../lib/daemon-notify.js';
import {
  encodeFrame,
  FrameParser,
  FRAME_KIND,
  helloFrame,
} from '../../lib/ipc-protocol.js';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

function connectSubscriber(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.setEncoding('utf8');
    const parser = new FrameParser();
    const inbox = [];
    const waiters = [];

    sock.on('data', (chunk) => {
      let parsed;
      try { parsed = Array.from(parser.feed(chunk)); }
      catch (e) { reject(e); return; }
      for (const f of parsed) {
        if (waiters.length > 0) waiters.shift()(f);
        else inbox.push(f);
      }
    });
    sock.on('error', reject);
    sock.once('connect', () => resolve({
      sock,
      send(frame) { sock.write(encodeFrame(frame)); },
      async waitFrame(timeoutMs = 1000) {
        if (inbox.length > 0) return inbox.shift();
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('waitFrame timeout')), timeoutMs);
          waiters.push((f) => { clearTimeout(t); res(f); });
        });
      },
      close() { sock.end(); },
    }));
  });
}

// ---------------------------------------------------------------------------

describe('producer → daemon → subscriber end-to-end', () => {
  let tmpDir;
  let daemon;
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-notify-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    if (daemon) {
      try { await daemon.stop(); } catch (_e) { /* already closed */ }
      daemon = null;
    }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  skipOnWindows('returns delivered:false (no throw) when the daemon is not running', async () => {
    const result = await notifyEmit(tmpDir, {
      event_id: 1,
      event_type: 'wicked.test.fired',
      domain: 'd', subdomain: '',
      payload: '{}',
    });
    expect(result.delivered).toBe(false);
    expect(['ENOENT', 'ECONNREFUSED', 'connect-timeout']).toContain(result.reason);
  });

  skipOnWindows('reports invalid-event for malformed event rows (no throw)', async () => {
    const result = await notifyEmit(tmpDir, { /* missing event_id */ });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('invalid-event');
  });

  skipOnWindows('delivers a produced frame and the daemon broadcasts to connected subscribers', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-A', cursor: 0 }));
    await connected;

    // Emit-side: send a produced frame
    const producedAck = new Promise(r => daemon.once('produced', r));
    const result = await notifyEmit(tmpDir, {
      event_id: 42,
      event_type: 'wicked.test.fired',
      domain: 'd', subdomain: '',
      payload: '{"n":42}',
    });

    expect(result.delivered).toBe(true);
    const ack = await producedAck;
    expect(ack.event_id).toBe(42);

    // Subscriber side: receive a notify frame for event_id 42
    const frame = await client.waitFrame(1000);
    expect(frame.kind).toBe(FRAME_KIND.NOTIFY);
    expect(frame.event_id).toBe(42);
    expect(frame.event).not.toBeNull();
    expect(frame.event.payload).toBe('{"n":42}');

    client.close();
  });

  skipOnWindows('respects the inline-payload threshold for produced frames', async () => {
    daemon = await startDaemon({ dataDir: tmpDir, inline_payload_max_bytes: 256 });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-B', cursor: 0 }));
    await connected;

    await notifyEmit(tmpDir, {
      event_id: 99,
      event_type: 'wicked.test.fired',
      domain: 'd', subdomain: '',
      payload: 'x'.repeat(2048),
    });

    const frame = await client.waitFrame(1000);
    expect(frame.event_id).toBe(99);
    expect(frame.event).toBeNull();

    client.close();
  });

  skipOnWindows('emits protocol-error for produced frames missing event_id', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });

    const errEvent = new Promise(r => daemon.once('protocol-error', r));

    // Hand-craft an invalid produced frame and send it directly. We bypass
    // notifyEmit() because it pre-validates (returning 'invalid-event'); we
    // want to exercise the daemon's server-side validation path.
    const sock = net.createConnection(daemon.socketPath);
    await new Promise(resolve => sock.once('connect', resolve));
    sock.write(JSON.stringify({ kind: 'produced', event: { /* no event_id */ } }) + '\n');

    const e = await errEvent;
    expect(e.error).toMatch(/missing event\.event_id/);

    sock.end();
  });

  skipOnWindows('emit() triggers a daemon notify that reaches a connected subscriber (full v1 wiring)', async () => {
    writeDefaultConfig(tmpDir);
    const config = loadConfig();
    const db = openDb(config);
    daemon = await startDaemon({ dataDir: tmpDir });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-emit', cursor: 0 }));
    await connected;

    // The actual v1 emit() function should fire the notify via setImmediate.
    const result = emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'demo',
      payload: { hello: 'world' },
    });
    expect(result.event_id).toBeGreaterThan(0);

    const frame = await client.waitFrame(2000);
    expect(frame.kind).toBe(FRAME_KIND.NOTIFY);
    expect(frame.event_id).toBe(result.event_id);
    expect(frame.event).not.toBeNull();
    expect(frame.event.event_type).toBe('wicked.test.fired');
    expect(JSON.parse(frame.event.payload)).toEqual({ hello: 'world' });

    client.close();
    db.close();
  });

  skipOnWindows('emit() with daemon_notify=false skips the notify entirely', async () => {
    writeDefaultConfig(tmpDir);
    const config = { ...loadConfig(), daemon_notify: false };
    const db = openDb(config);
    daemon = await startDaemon({ dataDir: tmpDir });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-skip', cursor: 0 }));
    await connected;

    emit(db, config, {
      event_type: 'wicked.test.fired',
      domain: 'demo',
      payload: {},
    });

    // Wait long enough that a notify would have arrived if it were going to.
    let received = null;
    try { received = await client.waitFrame(200); }
    catch (_e) { /* timeout expected */ }
    expect(received).toBeNull();

    client.close();
    db.close();
  });

  skipOnWindows('does not redeliver to subscribers whose cursor is at-or-above event_id', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-C', cursor: 50 }));
    await connected;

    await notifyEmit(tmpDir, {
      event_id: 50, event_type: 't', domain: 'd', subdomain: '', payload: '{}',
    });
    await notifyEmit(tmpDir, {
      event_id: 51, event_type: 't', domain: 'd', subdomain: '', payload: '{}',
    });

    const frame = await client.waitFrame(1000);
    expect(frame.event_id).toBe(51);

    client.close();
  });
});
