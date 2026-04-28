/**
 * Daemon push-IPC tests — happy path, inline-vs-pointer payload threshold,
 * filter scoping, ack-driven cursor advance, queue-overflow drop policy,
 * sustained-high-watermark `degrade` frame, and shutdown.
 *
 * Skipped on Windows: the spike binds to a Unix domain socket. Named-pipe
 * support comes with the daemon-binary CLI in a follow-up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import net from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  startDaemon,
  socketPath,
  DEFAULT_INLINE_PAYLOAD_MAX_BYTES,
} from '../../lib/daemon.js';
import {
  encodeFrame,
  FrameParser,
  FRAME_KIND,
  DEGRADE_REASONS,
  helloFrame,
  ackFrame,
  pingFrame,
} from '../../lib/ipc-protocol.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

// ---------------------------------------------------------------------------
// Subscriber test client — minimal raw-socket implementation
// ---------------------------------------------------------------------------

function connectSubscriber(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.setEncoding('utf8');
    const parser = new FrameParser();
    // Inbox is a FIFO of frames the test has not yet consumed via waitFrame().
    const inbox = [];
    const waiters = [];

    sock.on('data', (chunk) => {
      let parsed;
      try { parsed = Array.from(parser.feed(chunk)); }
      catch (e) { reject(e); return; }
      for (const f of parsed) {
        if (waiters.length > 0) {
          const w = waiters.shift();
          w(f);
        } else {
          inbox.push(f);
        }
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------

describe('daemon push-IPC', () => {
  let tmpDir;
  let daemon;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-daemon-' + randomUUID());
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

  skipOnWindows('socketPath() composes the canonical address', () => {
    expect(socketPath('/tmp/foo')).toBe('/tmp/foo/bus.sock');
  });

  skipOnWindows('starts and exposes status with zero subscribers', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const status = daemon.status();
    expect(status.subscriber_count).toBe(0);
    expect(status.config.subscriber_queue_max).toBeGreaterThan(0);
    expect(status.config.inline_payload_max_bytes).toBe(DEFAULT_INLINE_PAYLOAD_MAX_BYTES);
  });

  // -------------------------------------------------------------------------
  // Happy path — hello → broadcast → notify
  // -------------------------------------------------------------------------

  skipOnWindows('delivers a notify with inline payload to a connected subscriber', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const client = await connectSubscriber(daemon.socketPath);

    // Wait for daemon to register the subscriber after `hello`
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-A', cursor: 0, filter: null }));
    await connected;

    daemon.broadcast({
      event_id: 7,
      event_type: 'wicked.test.fired',
      domain: 'd',
      subdomain: '',
      payload: '{"n":7}',
    });

    const frame = await client.waitFrame(1000);
    expect(frame.kind).toBe(FRAME_KIND.NOTIFY);
    expect(frame.event_id).toBe(7);
    expect(frame.event).not.toBeNull();
    expect(frame.event.event_type).toBe('wicked.test.fired');

    client.close();
  });

  skipOnWindows('sends event:null when the encoded notify exceeds the inline threshold', async () => {
    daemon = await startDaemon({ dataDir: tmpDir, inline_payload_max_bytes: 256 });
    const client = await connectSubscriber(daemon.socketPath);

    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-B', cursor: 0 }));
    await connected;

    daemon.broadcast({
      event_id: 8,
      event_type: 'wicked.test.fired',
      domain: 'd',
      subdomain: '',
      payload: 'x'.repeat(2048),
    });

    const frame = await client.waitFrame(1000);
    expect(frame.kind).toBe(FRAME_KIND.NOTIFY);
    expect(frame.event_id).toBe(8);
    expect(frame.event).toBeNull();

    client.close();
  });

  skipOnWindows('respects subscriber filter (event_type)', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const client = await connectSubscriber(daemon.socketPath);

    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({
      subscriber_id: 'sub-C', cursor: 0,
      filter: { event_type: 'wicked.match.this' },
    }));
    await connected;

    daemon.broadcast({ event_id: 1, event_type: 'wicked.skip.me',    domain: 'd', subdomain: '', payload: '{}' });
    daemon.broadcast({ event_id: 2, event_type: 'wicked.match.this', domain: 'd', subdomain: '', payload: '{}' });

    const frame = await client.waitFrame(1000);
    expect(frame.event_id).toBe(2);

    client.close();
  });

  skipOnWindows('does not redeliver event_ids at or below the cursor', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const client = await connectSubscriber(daemon.socketPath);

    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-D', cursor: 50 }));
    await connected;

    daemon.broadcast({ event_id: 50, event_type: 't', domain: 'd', subdomain: '', payload: '{}' });
    daemon.broadcast({ event_id: 51, event_type: 't', domain: 'd', subdomain: '', payload: '{}' });

    const frame = await client.waitFrame(1000);
    expect(frame.event_id).toBe(51);                          // skipped 50

    client.close();
  });

  skipOnWindows('advances cursor on ack so re-broadcasts of the same id are filtered', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const client = await connectSubscriber(daemon.socketPath);

    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-E', cursor: 0 }));
    await connected;

    daemon.broadcast({ event_id: 100, event_type: 't', domain: 'd', subdomain: '', payload: '{}' });
    const frame1 = await client.waitFrame(1000);
    expect(frame1.event_id).toBe(100);

    const ackHandled = new Promise(r => daemon.once('ack', r));
    client.send(ackFrame({ event_id: 100 }));
    await ackHandled;

    // Re-broadcast same id — must be filtered (cursor now at 100)
    daemon.broadcast({ event_id: 100, event_type: 't', domain: 'd', subdomain: '', payload: '{}' });
    daemon.broadcast({ event_id: 101, event_type: 't', domain: 'd', subdomain: '', payload: '{}' });

    const frame2 = await client.waitFrame(1000);
    expect(frame2.event_id).toBe(101);

    client.close();
  });

  skipOnWindows('responds to ping with pong', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });
    const client = await connectSubscriber(daemon.socketPath);

    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-F', cursor: 0 }));
    await connected;

    client.send(pingFrame());
    const frame = await client.waitFrame(1000);
    expect(frame.kind).toBe(FRAME_KIND.PONG);

    client.close();
  });

  // -------------------------------------------------------------------------
  // Queue overflow + degrade contract
  // -------------------------------------------------------------------------

  skipOnWindows('drops oldest frames when the per-subscriber queue is full', async () => {
    // We simulate a saturated subscriber by NOT reading frames after hello,
    // and by capping the queue very low so writes pile up. The session-level
    // queue is in front of the kernel's send buffer, but since v1 of the
    // spike pushes to the kernel buffer aggressively, this test exercises
    // the per-session enqueue() drop path directly via direct broadcast
    // beyond capacity.
    daemon = await startDaemon({
      dataDir: tmpDir,
      subscriber_queue_max: 4,
      degrade_high_watermark: 0.99,                            // disable degrade for this test
      degrade_duration_ms: 1_000_000,
    });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-G', cursor: 0 }));
    await connected;

    const drops = [];
    daemon.on('queue-drop', (e) => drops.push(e));

    // Pause the client socket so frames cannot drain — the kernel buffer
    // and per-session queue both fill.
    client.sock.pause();

    // Emit far more events than the cap to force the drop path. We can't
    // assert a specific count because the kernel buffer absorbs some frames,
    // but for any reasonably tight cap the per-session queue WILL overflow.
    for (let i = 0; i < 5000; i++) {
      daemon.broadcast({
        event_id: i + 1,
        event_type: 't',
        domain: 'd',
        subdomain: '',
        payload: 'x'.repeat(2048),
      });
    }

    // Allow event-loop ticks for the queue to settle
    await delay(50);

    expect(drops.length).toBeGreaterThan(0);

    client.sock.resume();
    client.close();
  });

  skipOnWindows('sends degrade(queue-full) after sustained high-watermark', async () => {
    daemon = await startDaemon({
      dataDir: tmpDir,
      subscriber_queue_max: 4,
      degrade_high_watermark: 0.5,                             // hwm = 2 frames
      degrade_duration_ms: 50,                                 // very short window for the test
    });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-H', cursor: 0 }));
    await connected;

    const degraded = new Promise(r => daemon.once('degrade', r));

    // Pause client → queue fills
    client.sock.pause();

    // Sustain high-watermark for >50 ms by hammering broadcasts
    const t0 = Date.now();
    while (Date.now() - t0 < 200) {
      for (let i = 0; i < 50; i++) {
        daemon.broadcast({
          event_id: i + 1,
          event_type: 't',
          domain: 'd',
          subdomain: '',
          payload: 'x'.repeat(2048),
        });
      }
      await delay(10);
    }

    const event = await Promise.race([
      degraded,
      delay(2000).then(() => null),
    ]);
    expect(event).not.toBeNull();
    expect(event.reason).toBe(DEGRADE_REASONS.QUEUE_FULL);

    client.sock.resume();
    client.close();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  skipOnWindows('stop() sends degrade(daemon-shutdown) to active subscribers', async () => {
    daemon = await startDaemon({ dataDir: tmpDir });

    const client = await connectSubscriber(daemon.socketPath);
    const connected = new Promise(r => daemon.once('subscriber-connect', r));
    client.send(helloFrame({ subscriber_id: 'sub-I', cursor: 0 }));
    await connected;

    const degradePromise = client.waitFrame(1000);
    await daemon.stop();
    daemon = null;

    const frame = await degradePromise;
    expect(frame.kind).toBe(FRAME_KIND.DEGRADE);
    expect(frame.reason).toBe(DEGRADE_REASONS.DAEMON_SHUTDOWN);
  });
});
