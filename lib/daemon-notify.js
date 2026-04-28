/**
 * Producer-side daemon notifier.
 *
 * `notifyEmit(dataDir, eventRow)` sends a single `produced` frame to the
 * daemon's socket and closes. Best-effort + fire-and-forget per DESIGN-v2.md
 * §7.1: the producer never blocks on the daemon, never retries, never
 * surfaces an error. A missed notify just means subscribers see the event
 * via poll fallback instead of push — which they were prepared to do anyway
 * (the daemon is optional in v2.0).
 *
 * Caller contract:
 *   - eventRow MUST be a fully-formed event with a numeric event_id.
 *   - The function returns a Promise that resolves whether or not the
 *     daemon was reachable. It NEVER throws; errors are silently swallowed
 *     because emit() must remain non-blocking.
 *
 * Why a fresh connection per emit instead of a long-lived one:
 *   - emit() is synchronous (better-sqlite3) but the notify is async (Node
 *     net.Socket). Detaching them keeps emit() non-blocking.
 *   - One-shot connections are simple to reason about and avoid keep-alive
 *     bookkeeping in the producer's hot path.
 *   - Cost is ~0.1-0.3ms per emit on a hot Unix socket; if profiling later
 *     proves this matters, we add a connection pool.
 *
 * @module lib/daemon-notify
 */

import net from 'node:net';
import { encodeFrame, producedFrame } from './ipc-protocol.js';
import { socketPath } from './daemon.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 50;
export const DEFAULT_WRITE_TIMEOUT_MS   = 50;

/**
 * Send a `produced` notification to the daemon (best-effort).
 *
 * @param {string} dataDir - parent dir holding bus.sock
 * @param {object} eventRow - event with numeric event_id
 * @param {object} [opts]
 * @param {number} [opts.connect_timeout_ms]
 * @param {number} [opts.write_timeout_ms]
 * @returns {Promise<{ delivered: boolean, reason?: string }>}
 */
export function notifyEmit(dataDir, eventRow, opts = {}) {
  const connectTimeout = opts.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const writeTimeout   = opts.write_timeout_ms   ?? DEFAULT_WRITE_TIMEOUT_MS;
  const sock = socketPath(dataDir);

  return new Promise((resolve) => {
    let settled = false;
    function settle(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let line;
    try {
      line = encodeFrame(producedFrame({ event: eventRow }));
    } catch (e) {
      // Bad event row — caller bug. Don't throw (fire-and-forget) but report.
      settle({ delivered: false, reason: 'invalid-event' });
      return;
    }

    const client = net.createConnection(sock);

    const connectTimer = setTimeout(() => {
      try { client.destroy(); } catch (_e) { /* ignore */ }
      settle({ delivered: false, reason: 'connect-timeout' });
    }, connectTimeout);

    client.once('connect', () => {
      clearTimeout(connectTimer);

      const writeTimer = setTimeout(() => {
        try { client.destroy(); } catch (_e) { /* ignore */ }
        settle({ delivered: false, reason: 'write-timeout' });
      }, writeTimeout);

      // Write + immediately close. We don't wait for the daemon to
      // acknowledge — there's no ack frame for `produced` by design.
      client.end(line, 'utf8', () => {
        clearTimeout(writeTimer);
        settle({ delivered: true });
      });
    });

    client.once('error', (e) => {
      clearTimeout(connectTimer);
      // ENOENT (no socket file) or ECONNREFUSED (no listener) → daemon down.
      // Don't surface as an error; that's the expected fall-back path.
      settle({ delivered: false, reason: e.code || 'error' });
    });
  });
}
