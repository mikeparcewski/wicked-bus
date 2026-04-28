/**
 * IPC wire protocol for the v2 daemon — line-delimited JSON.
 * Each frame is one JSON object terminated by '\n'. Debuggable with `nc -U`.
 *
 * Frame kinds:
 *   - hello      (subscriber → daemon)   announce subscription, cursor, filter
 *   - notify     (daemon → subscriber)   { event_id, event? }
 *                                        `event` carries inline payload when
 *                                        the encoded event is below the
 *                                        per-daemon `inline_payload_max_bytes`
 *                                        threshold. Above, `event` is null and
 *                                        the subscriber resolves via SELECT.
 *   - ack        (subscriber → daemon)   acknowledge an event_id
 *   - ping/pong  (either direction)      keep-alive
 *   - degrade    (daemon → subscriber)   "fall back to poll", reason included.
 *                                        Subscriber MUST treat as EOF: log,
 *                                        switch to poll mode, advance cursor
 *                                        via SQLite (no events lost — cursor
 *                                        is anchored in the live DB).
 *
 * Reference: DESIGN-v2.md §7.2.
 *
 * @module lib/ipc-protocol
 */

export const FRAME_KIND = Object.freeze({
  HELLO:    'hello',
  NOTIFY:   'notify',
  ACK:      'ack',
  PING:     'ping',
  PONG:     'pong',
  DEGRADE:  'degrade',
  PRODUCED: 'produced',  // producer → daemon: "this event was just emitted, fan out"
});

export const DEGRADE_REASONS = Object.freeze({
  QUEUE_FULL:        'queue-full',
  WRITE_TIMEOUT:     'write-timeout',
  DAEMON_SHUTDOWN:   'daemon-shutdown',
});

/**
 * Encode a frame to a single newline-terminated line.
 * @param {object} frame
 * @returns {string}
 */
export function encodeFrame(frame) {
  if (!frame || typeof frame !== 'object') {
    throw new Error('encodeFrame requires an object');
  }
  if (!frame.kind || !Object.values(FRAME_KIND).includes(frame.kind)) {
    throw new Error(`encodeFrame: unknown kind '${frame.kind}'`);
  }
  return JSON.stringify(frame) + '\n';
}

/**
 * Stream frame parser. Handles arbitrary chunk boundaries by buffering until
 * a newline arrives, then emitting one frame per complete line.
 *
 * Usage:
 *   const parser = new FrameParser();
 *   for (const frame of parser.feed(chunk)) { ... }
 */
export class FrameParser {
  constructor() {
    this._buf = '';
  }

  /**
   * Feed a chunk; yield zero or more parsed frames.
   * @param {Buffer|string} chunk
   * @returns {Generator<object>}
   */
  *feed(chunk) {
    this._buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (line.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new Error(`malformed frame (invalid JSON): ${e.message}`);
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.kind) {
        throw new Error(`malformed frame (missing kind): ${line.slice(0, 60)}`);
      }
      yield parsed;
    }
  }

  /** True when there is unparsed buffered data (partial frame in flight). */
  hasPending() {
    return this._buf.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Frame factory helpers — each returns a fully-formed frame object that
// `encodeFrame` will accept. Keeping these out-of-line makes the protocol
// easier to grep and harder to mistype.
// ---------------------------------------------------------------------------

export function helloFrame({ subscriber_id, cursor, filter = null }) {
  return { kind: FRAME_KIND.HELLO, subscriber_id, cursor, filter };
}

export function notifyFrame({ event_id, event = null }) {
  return { kind: FRAME_KIND.NOTIFY, event_id, event };
}

export function ackFrame({ event_id }) {
  return { kind: FRAME_KIND.ACK, event_id };
}

export function pingFrame() {
  return { kind: FRAME_KIND.PING };
}

export function pongFrame() {
  return { kind: FRAME_KIND.PONG };
}

export function degradeFrame({ reason }) {
  if (!Object.values(DEGRADE_REASONS).includes(reason)) {
    throw new Error(`degradeFrame: unknown reason '${reason}'`);
  }
  return { kind: FRAME_KIND.DEGRADE, reason };
}

/**
 * Producer → daemon: "this event was just inserted into bus.db; fan it out
 * to connected subscribers." Best-effort. Daemon may receive the same
 * event_id more than once if a producer retries; the daemon dedupes by
 * `event_id` against subscriber cursors.
 */
export function producedFrame({ event }) {
  if (!event || typeof event.event_id !== 'number') {
    throw new Error('producedFrame requires event with numeric event_id');
  }
  return { kind: FRAME_KIND.PRODUCED, event };
}

/**
 * Compute the encoded byte length of an event's notify frame, used to decide
 * whether to send the payload inline (frame `event` populated) or pointer-only
 * (`event: null` so the subscriber SELECTs). Helper exposed for the daemon
 * and for tests.
 */
export function encodedNotifySize(eventRow) {
  return Buffer.byteLength(JSON.stringify(notifyFrame({
    event_id: eventRow.event_id,
    event: eventRow,
  })), 'utf8');
}
