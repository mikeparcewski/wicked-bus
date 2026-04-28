/**
 * v2 push-delivery daemon.
 *
 * - Listens on a Unix domain socket at `<data_dir>/bus.sock`. Subscribers
 *   connect, send a `hello`, and receive `notify` frames as events arrive.
 * - Inline-payload strategy (DESIGN-v2.md §7.2): notify carries the full
 *   event when `JSON.stringify(notify)` is under the threshold (default
 *   16 KB, configurable per-daemon). Above, `event` is null and the
 *   subscriber resolves via SELECT.
 * - Per-subscriber bounded send queue, oldest-first drop policy, `degrade`
 *   frame on saturation (round-2 fix per Copilot's EAGAIN concern).
 * - Singleton via `flock(2)` on `daemon.lock`.
 *
 * Wiring to producers (emit → daemon notify) is intentionally out of scope
 * for this module. Producers call `daemon.broadcast(eventRow)` (in-process
 * test path) or send a `produced` notification over a future producer-side
 * socket (out of scope here). The fan-out, queueing, and drop-policy logic
 * is identical regardless of how the daemon was notified.
 *
 * @module lib/daemon
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  encodeFrame,
  FrameParser,
  FRAME_KIND,
  DEGRADE_REASONS,
  notifyFrame,
  pongFrame,
  degradeFrame,
  encodedNotifySize,
} from './ipc-protocol.js';

export const DEFAULT_INLINE_PAYLOAD_MAX_BYTES = 16 * 1024;
export const DEFAULT_SUBSCRIBER_QUEUE_MAX     = 256;
export const DEFAULT_WRITE_TIMEOUT_MS         = 250;
export const DEFAULT_DEGRADE_HIGH_WATERMARK   = 0.75;
export const DEFAULT_DEGRADE_DURATION_MS      = 30_000;

/**
 * Start the daemon. Returns a handle with `broadcast`, `stop`, `status`.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - parent dir holding bus.sock and bus.db
 * @param {number} [opts.inline_payload_max_bytes]
 * @param {number} [opts.subscriber_queue_max]
 * @param {number} [opts.write_timeout_ms]
 * @param {number} [opts.degrade_high_watermark]    - 0..1
 * @param {number} [opts.degrade_duration_ms]
 * @returns {Promise<DaemonHandle>}
 */
export async function startDaemon(opts) {
  const dataDir = mustHave(opts, 'dataDir');
  const cfg = {
    inline_payload_max_bytes: opts.inline_payload_max_bytes ?? DEFAULT_INLINE_PAYLOAD_MAX_BYTES,
    subscriber_queue_max:     opts.subscriber_queue_max     ?? DEFAULT_SUBSCRIBER_QUEUE_MAX,
    write_timeout_ms:         opts.write_timeout_ms         ?? DEFAULT_WRITE_TIMEOUT_MS,
    degrade_high_watermark:   opts.degrade_high_watermark   ?? DEFAULT_DEGRADE_HIGH_WATERMARK,
    degrade_duration_ms:      opts.degrade_duration_ms      ?? DEFAULT_DEGRADE_DURATION_MS,
  };

  // Stale socket cleanup. flock-based singleton lives in a sibling PR; for
  // this spike we use plain `EADDRINUSE` detection at listen() time.
  const sockPath = socketPath(dataDir);
  try { fs.unlinkSync(sockPath); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  return new Promise((resolve, reject) => {
    const events = new EventEmitter();
    const subscribers = new Map(); // subscriber_id → SubscriberSession
    const allSessions = new Set(); // every accepted socket, registered or not

    /**
     * Fan an event row out to every connected subscriber whose filter matches
     * and whose cursor is below event_id. Used by both the in-process
     * `handle.broadcast()` and the cross-process `produced` frame handler.
     */
    function broadcast(eventRow) {
      const inlineSize = encodedNotifySize(eventRow);
      const inline = inlineSize <= cfg.inline_payload_max_bytes;
      const frame = notifyFrame({
        event_id: eventRow.event_id,
        event: inline ? eventRow : null,
      });
      const line = encodeFrame(frame);

      for (const session of subscribers.values()) {
        if (!matchesFilter(eventRow, session.filter)) continue;
        if (eventRow.event_id <= session.cursor) continue;
        session.enqueue(line);
      }
    }

    const ctx = { subscribers, allSessions, cfg, events, broadcast };
    const server = net.createServer((sock) => onConnection(sock, ctx));

    server.on('error', reject);
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch (_e) { /* best-effort on non-POSIX */ }

      const handle = makeHandle({
        server, sockPath, subscribers, allSessions, cfg, events, broadcast,
      });
      resolve(handle);
    });
  });
}

// Unix-domain-socket path limits: Linux ~108 bytes, macOS 104 bytes (sun_path
// in sockaddr_un). On Windows we'd use a named pipe at \\.\pipe\... — out of
// scope for this spike but worth the cross-platform shape now.
const UNIX_SOCKET_PATH_LIMIT = 100;   // conservative for both platforms

/**
 * Standard socket path for a given data dir.
 *
 * If the natural `<dataDir>/bus.sock` path would exceed the platform's
 * sun_path limit (common with deep tmpdirs on macOS test runners), we fall
 * back to a short hashed name in `os.tmpdir()` and persist the path in
 * `<dataDir>/socket.path` so subscribers and CLIs can find it.
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function socketPath(dataDir) {
  const natural = path.join(dataDir, 'bus.sock');
  if (Buffer.byteLength(natural, 'utf8') <= UNIX_SOCKET_PATH_LIMIT) {
    return natural;
  }
  // Fallback: short path in os.tmpdir(). The hash provides per-dataDir
  // isolation. We persist it so subscribers can find it without recomputing.
  return shortSocketFor(dataDir);
}

function shortSocketFor(dataDir) {
  const persisted = path.join(dataDir, 'socket.path');
  try {
    const recorded = fs.readFileSync(persisted, 'utf8').trim();
    if (recorded) return recorded;
  } catch (_e) { /* not yet recorded */ }

  const hash = simpleHash(dataDir);
  const short = path.join(os.tmpdir(), `wb-${hash}.sock`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(persisted, short);
  } catch (_e) { /* can't persist — caller is recomputing each call */ }
  return short;
}

function simpleHash(s) {
  // 64-bit-ish fnv-1a, hex-stringified. We don't need cryptographic strength
  // here — we just want a short, deterministic, dataDir-keyed name.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Subscriber session
// ---------------------------------------------------------------------------

class SubscriberSession {
  constructor(socket, cfg, events) {
    this.socket = socket;
    this.cfg = cfg;
    this.events = events;
    this.subscriber_id = null;
    this.cursor = 0;
    this.filter = null;
    this.queue = [];                           // pending notify frames (string lines)
    this.dropped_count = 0;
    this.high_watermark_since = null;          // ms timestamp when queue first crossed HWM
    this.last_degrade_at = null;
    this.closed = false;
    this._drain_pending = false;               // single drain listener at a time
  }

  /**
   * Enqueue a notify frame for this subscriber. Applies oldest-first drop
   * when the queue is at the configured cap. May trigger a `degrade` frame
   * when sustained high-watermark is observed.
   */
  enqueue(line) {
    if (this.closed) return;

    if (this.queue.length >= this.cfg.subscriber_queue_max) {
      this.queue.shift();                      // oldest-first drop
      this.dropped_count++;
      this.events.emit('queue-drop', {
        subscriber_id: this.subscriber_id,
        dropped_count: this.dropped_count,
      });
    }

    this.queue.push(line);
    this._checkHighWatermark();
    this._flush();
  }

  _checkHighWatermark() {
    const cap = this.cfg.subscriber_queue_max;
    const hwm = Math.floor(cap * this.cfg.degrade_high_watermark);
    if (this.queue.length >= hwm) {
      if (this.high_watermark_since === null) {
        this.high_watermark_since = Date.now();
      } else if (Date.now() - this.high_watermark_since >= this.cfg.degrade_duration_ms) {
        this.degrade(DEGRADE_REASONS.QUEUE_FULL);
      }
    } else {
      this.high_watermark_since = null;
    }
  }

  /**
   * Best-effort drain: write as many buffered frames as the socket accepts.
   * Real send-buffer back-pressure is handled by the kernel's socket buffer;
   * if write() returns false (Node's drain signal) we wait for 'drain'.
   */
  _flush() {
    if (this.closed) return;
    while (this.queue.length > 0) {
      const line = this.queue[0];
      const ok = this.socket.write(line);
      if (!ok) {
        // back-pressure — register a single drain listener regardless of how
        // many enqueue() calls happen while we're waiting. Stacking listeners
        // produces a MaxListenersExceededWarning under high-volume broadcasts.
        if (!this._drain_pending) {
          this._drain_pending = true;
          this.socket.once('drain', () => {
            this._drain_pending = false;
            this._flush();
          });
        }
        break;
      }
      this.queue.shift();
    }
  }

  send(frame) {
    if (this.closed) return;
    this.enqueue(encodeFrame(frame));
  }

  /**
   * Send a degrade frame and close the socket. Idempotent.
   */
  degrade(reason) {
    if (this.closed) return;
    this.last_degrade_at = Date.now();
    try {
      this.socket.write(encodeFrame(degradeFrame({ reason })));
    } catch (_e) { /* socket may already be broken */ }
    this.events.emit('degrade', {
      subscriber_id: this.subscriber_id,
      reason,
    });
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch (_e) { /* ignore */ }
  }

  status() {
    return {
      subscriber_id: this.subscriber_id,
      cursor: this.cursor,
      queue_depth: this.queue.length,
      queue_max: this.cfg.subscriber_queue_max,
      dropped_count: this.dropped_count,
      last_degrade_at: this.last_degrade_at,
      high_watermark_since: this.high_watermark_since,
    };
  }
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function onConnection(socket, ctx) {
  socket.setEncoding('utf8');
  const parser = new FrameParser();
  const session = new SubscriberSession(socket, ctx.cfg, ctx.events);
  ctx.allSessions.add(session);

  socket.on('data', (chunk) => {
    let frames;
    try {
      frames = Array.from(parser.feed(chunk));
    } catch (e) {
      ctx.events.emit('protocol-error', { error: e.message });
      session.close();
      return;
    }
    for (const frame of frames) handleFrame(frame, session, ctx);
  });

  socket.on('close', () => {
    if (session.subscriber_id !== null) {
      ctx.subscribers.delete(session.subscriber_id);
    }
    ctx.allSessions.delete(session);
    session.closed = true;
    ctx.events.emit('subscriber-disconnect', { subscriber_id: session.subscriber_id });
  });

  socket.on('error', (e) => {
    ctx.events.emit('socket-error', {
      subscriber_id: session.subscriber_id,
      error: e.message,
    });
  });
}

function handleFrame(frame, session, ctx) {
  switch (frame.kind) {
    case FRAME_KIND.HELLO: {
      session.subscriber_id = frame.subscriber_id;
      session.cursor = frame.cursor ?? 0;
      session.filter = frame.filter ?? null;
      ctx.subscribers.set(session.subscriber_id, session);
      ctx.events.emit('subscriber-connect', {
        subscriber_id: session.subscriber_id,
        cursor: session.cursor,
        filter: session.filter,
      });
      break;
    }
    case FRAME_KIND.ACK: {
      if (typeof frame.event_id === 'number') {
        session.cursor = Math.max(session.cursor, frame.event_id);
        ctx.events.emit('ack', {
          subscriber_id: session.subscriber_id,
          event_id: frame.event_id,
        });
      }
      break;
    }
    case FRAME_KIND.PING: {
      session.send(pongFrame());
      break;
    }
    case FRAME_KIND.PRODUCED: {
      // Producer → daemon: an event was inserted into bus.db, fan it out.
      // Best-effort: invalid frames are dropped silently with an event hook
      // so operators can correlate. Producers don't need an ack.
      if (frame.event && typeof frame.event.event_id === 'number') {
        ctx.broadcast(frame.event);
        ctx.events.emit('produced', { event_id: frame.event.event_id });
      } else {
        ctx.events.emit('protocol-error', {
          error: 'produced frame missing event.event_id',
        });
      }
      break;
    }
    default:
      // Unknown frame: log, do not close (forward-compat).
      ctx.events.emit('unknown-frame', { kind: frame.kind });
  }
}

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

function makeHandle({ server, sockPath, subscribers, allSessions, cfg, events, broadcast }) {
  return {
    /**
     * Fan an event row out to every connected subscriber whose filter matches.
     * Frame uses inline payload when below threshold; null otherwise.
     * Identical behavior to receiving a `produced` frame from a remote producer.
     */
    broadcast,

    /**
     * Address to connect to.
     */
    socketPath: sockPath,

    /**
     * Live status snapshot — per-subscriber queue depth, drops, etc.
     */
    status() {
      const sessions = [];
      for (const s of subscribers.values()) sessions.push(s.status());
      return {
        socket: sockPath,
        config: cfg,
        subscribers: sessions,
        subscriber_count: subscribers.size,
      };
    },

    /**
     * Event hook for tests and operators: 'subscriber-connect',
     * 'subscriber-disconnect', 'ack', 'queue-drop', 'degrade',
     * 'protocol-error', 'socket-error', 'unknown-frame'.
     */
    on(name, cb) { events.on(name, cb); return this; },
    once(name, cb) { events.once(name, cb); return this; },
    off(name, cb) { events.off(name, cb); return this; },

    async stop() {
      // Send `degrade(daemon-shutdown)` to every accepted session — including
      // ones that hadn't sent `hello` yet (otherwise server.close() deadlocks
      // on those connections, since neither side initiates FIN). degrade()
      // also calls socket.end() so the kernel can drain the FIN handshake.
      for (const s of allSessions) s.degrade(DEGRADE_REASONS.DAEMON_SHUTDOWN);
      await new Promise(resolve => server.close(() => resolve()));
      try { fs.unlinkSync(sockPath); } catch (_e) { /* ignore */ }
    },
  };
}

function matchesFilter(eventRow, filter) {
  if (!filter) return true;
  if (filter.event_type && eventRow.event_type !== filter.event_type) return false;
  if (filter.domain     && eventRow.domain     !== filter.domain)     return false;
  if (filter.subdomain  && eventRow.subdomain  !== filter.subdomain)  return false;
  return true;
}

function mustHave(obj, key) {
  if (!obj || obj[key] == null) {
    throw new Error(`startDaemon requires opts.${key}`);
  }
  return obj[key];
}
