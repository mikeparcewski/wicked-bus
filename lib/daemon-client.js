/**
 * Subscriber-side daemon client.
 *
 * `probeDaemon(dataDir)` returns whether the daemon socket accepts a connection
 * within a configurable timeout. `connectAsSubscriber(...)` returns a push-mode
 * subscriber as an async iterator: `for await (const event of sub)` yields
 * notify payloads (or `{ event_id, event: null }` placeholders for above-
 * threshold notifies the caller must resolve via SELECT).
 *
 * Per DESIGN-v2.md §7.4:
 *   - Initial probe on a hard timeout (default 100ms).
 *   - Once connected, EOF / `degrade` frame ends the iterator and surfaces
 *     a `degraded` flag the caller uses to decide whether to fall back to
 *     poll mode. The fall-back logic itself lives one layer up because it
 *     needs the live DB connection.
 *
 * Spawn-on-miss is intentionally out of scope for this module — that's a
 * caller decision (some embedders want strict no-spawn semantics). A future
 * `subscribePushOrPoll()` helper will compose `probeDaemon` + spawn + fall-back.
 *
 * @module lib/daemon-client
 */

import net from 'node:net';
import {
  encodeFrame,
  FrameParser,
  FRAME_KIND,
  helloFrame,
  ackFrame,
  pingFrame,
} from './ipc-protocol.js';
import { socketPath } from './daemon.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 100;

/**
 * Test whether a daemon is reachable at this dataDir's socket within `timeoutMs`.
 * Resolves true/false; never throws.
 */
export function probeDaemon(dataDir, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath(dataDir));
    const t = setTimeout(() => {
      try { sock.destroy(); } catch (_e) { /* ignore */ }
      resolve(false);
    }, timeoutMs);

    sock.once('connect', () => {
      clearTimeout(t);
      try { sock.end(); } catch (_e) { /* ignore */ }
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/**
 * Connect as a push-mode subscriber. The returned object is an async iterable
 * yielding notify payloads. `ack(event_id)` advances the daemon-side cursor.
 * `close()` ends the iterator.
 *
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.subscriber_id
 * @param {number} [opts.cursor]
 * @param {object|null} [opts.filter]
 * @param {number} [opts.connect_timeout_ms]
 * @returns {Promise<PushSubscriber>}
 */
export function connectAsSubscriber(opts) {
  const dataDir       = opts.dataDir;
  const subscriberId  = opts.subscriber_id;
  const cursor        = opts.cursor ?? 0;
  const filter        = opts.filter ?? null;
  const connectTimeout = opts.connect_timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!dataDir) throw new Error('connectAsSubscriber requires opts.dataDir');
  if (!subscriberId) throw new Error('connectAsSubscriber requires opts.subscriber_id');

  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath(dataDir));
    sock.setEncoding('utf8');
    const parser = new FrameParser();
    const inbox = [];           // queued notify payloads ready for the iterator
    const waiters = [];         // pending iterator-next promise resolvers
    let degraded = null;        // { reason } once a degrade arrives
    let closed = false;
    let pongResolver = null;    // for ping/pong helper

    const connectTimer = setTimeout(() => {
      try { sock.destroy(); } catch (_e) { /* ignore */ }
      reject(new Error('daemon connect timeout'));
    }, connectTimeout);

    sock.once('error', (e) => {
      clearTimeout(connectTimer);
      if (!resolved) reject(e);
      else endIterator({ reason: 'socket-error', error: e.message });
    });

    let resolved = false;
    sock.once('connect', () => {
      clearTimeout(connectTimer);
      sock.write(encodeFrame(helloFrame({
        subscriber_id: subscriberId,
        cursor,
        filter,
      })));
      resolved = true;
      resolve(buildHandle());
    });

    sock.on('data', (chunk) => {
      let frames;
      try { frames = Array.from(parser.feed(chunk)); }
      catch (e) { endIterator({ reason: 'protocol-error', error: e.message }); return; }
      for (const f of frames) handleFrame(f);
    });

    sock.on('close', () => {
      endIterator({ reason: degraded ? degraded.reason : 'eof' });
    });

    function handleFrame(frame) {
      switch (frame.kind) {
        case FRAME_KIND.NOTIFY:
          deliver(frame);
          return;
        case FRAME_KIND.DEGRADE:
          degraded = { reason: frame.reason };
          endIterator({ reason: frame.reason });
          return;
        case FRAME_KIND.PONG:
          if (pongResolver) { pongResolver(true); pongResolver = null; }
          return;
        // Other kinds (hello/ack/ping/produced) are server-bound; ignore.
      }
    }

    function deliver(frame) {
      if (waiters.length > 0) {
        const w = waiters.shift();
        w({ value: frame, done: false });
      } else {
        inbox.push(frame);
      }
    }

    function endIterator(state) {
      if (closed) return;
      closed = true;
      try { sock.end(); } catch (_e) { /* ignore */ }
      while (waiters.length > 0) {
        const w = waiters.shift();
        w({ value: undefined, done: true });
      }
      // `state` is recorded on the handle so callers can introspect.
      if (handleRef) handleRef.lastState = state;
    }

    let handleRef = null;
    function buildHandle() {
      handleRef = {
        subscriber_id: subscriberId,
        lastState: null,

        ack(eventId) {
          if (closed) return;
          sock.write(encodeFrame(ackFrame({ event_id: eventId })));
        },

        ping() {
          if (closed) return Promise.resolve(false);
          return new Promise(res => {
            pongResolver = res;
            sock.write(encodeFrame(pingFrame()));
            setTimeout(() => {
              if (pongResolver === res) { pongResolver = null; res(false); }
            }, 500);
          });
        },

        get degraded() { return degraded; },
        get isClosed() { return closed; },

        close() {
          if (closed) return;
          endIterator({ reason: 'caller-close' });
        },

        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (inbox.length > 0) {
              yield inbox.shift();
              continue;
            }
            const next = await new Promise(res => waiters.push(res));
            if (next.done) return;
            yield next.value;
          }
        },
      };
      return handleRef;
    }
  });
}
