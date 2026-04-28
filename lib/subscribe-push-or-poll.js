/**
 * Push-or-poll subscriber wrapper — DESIGN-v2.md §7.4 degradation contract.
 *
 * Caller hands in a v1 cursor_id and gets one async iterable. Internally:
 *   1. Probe the daemon socket. If reachable, connect as a push subscriber
 *      and yield notifies as they arrive. Each notify is ack'd before the
 *      next iteration step (preserves "ack before advance" v1 semantics).
 *   2. On EOF / `degrade` frame / unreachable daemon, transparently fall
 *      back to v1 poll mode using the same cursor_id. The cursor is
 *      anchored in SQLite, so no events are lost across the handoff.
 *   3. Periodic re-probe in poll mode: every `reprobe_interval_ms`, the
 *      wrapper checks whether the daemon has come back. If so, it switches
 *      back to push mode after the current poll batch drains. Optional —
 *      controlled by `auto_recover` (default true).
 *
 * The returned iterable is the only API. Caller uses:
 *
 *     const sub = await subscribePushOrPoll({ db, cursor_id, dataDir });
 *     for await (const event of sub) {
 *       // process(event)
 *     }
 *
 * Inline notifies (frame.event populated) are yielded directly. Pointer-only
 * notifies (frame.event === null) are resolved via the live DB. The object
 * also exposes `mode` (current 'push' | 'poll') for observability.
 *
 * @module lib/subscribe-push-or-poll
 */

import { probeDaemon, connectAsSubscriber } from './daemon-client.js';
import { poll, ack } from './poll.js';

export const DEFAULT_POLL_INTERVAL_MS    = 250;
export const DEFAULT_REPROBE_INTERVAL_MS = 5000;
export const DEFAULT_PROBE_TIMEOUT_MS    = 100;

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db          - live DB connection (poll fallback + pointer resolution)
 * @param {string}  opts.cursor_id
 * @param {string}  opts.dataDir
 * @param {string}  [opts.subscriber_id]                       - daemon-side id (defaults to cursor_id)
 * @param {object}  [opts.filter]                              - daemon-side filter spec
 * @param {number}  [opts.poll_interval_ms]
 * @param {number}  [opts.reprobe_interval_ms]
 * @param {number}  [opts.probe_timeout_ms]
 * @param {boolean} [opts.auto_recover=true]                   - re-probe when in poll mode
 * @returns {Promise<PushOrPollSubscriber>}
 */
export async function subscribePushOrPoll(opts) {
  if (!opts || !opts.db || !opts.cursor_id || !opts.dataDir) {
    throw new Error('subscribePushOrPoll requires { db, cursor_id, dataDir }');
  }

  const cfg = {
    db:                   opts.db,
    cursor_id:            opts.cursor_id,
    dataDir:              opts.dataDir,
    subscriber_id:        opts.subscriber_id        ?? opts.cursor_id,
    filter:               opts.filter               ?? null,
    poll_interval_ms:     opts.poll_interval_ms     ?? DEFAULT_POLL_INTERVAL_MS,
    reprobe_interval_ms:  opts.reprobe_interval_ms  ?? DEFAULT_REPROBE_INTERVAL_MS,
    probe_timeout_ms:     opts.probe_timeout_ms     ?? DEFAULT_PROBE_TIMEOUT_MS,
    auto_recover:         opts.auto_recover !== false,
  };

  const state = {
    mode: 'poll',                 // 'push' | 'poll'
    pushSub: null,                // PushSubscriber when in push mode
    closed: false,
    lastProbeAt: 0,
    transitionCount: 0,
    /** Reset to a fresh sleep handle so close() can interrupt it. */
    sleeper: null,
  };

  // Initial probe
  if (await probeDaemon(cfg.dataDir, cfg.probe_timeout_ms)) {
    await tryEnterPush(state, cfg);
  }

  return buildHandle(state, cfg);
}

// ---------------------------------------------------------------------------

async function tryEnterPush(state, cfg) {
  try {
    const cursorRow = cfg.db.prepare(
      'SELECT last_event_id FROM cursors WHERE cursor_id = ?'
    ).get(cfg.cursor_id);
    const cursor = cursorRow ? cursorRow.last_event_id : 0;

    state.pushSub = await connectAsSubscriber({
      dataDir:        cfg.dataDir,
      subscriber_id:  cfg.subscriber_id,
      cursor,
      filter:         cfg.filter,
      connect_timeout_ms: cfg.probe_timeout_ms,
    });
    state.mode = 'push';
    state.transitionCount++;
    return true;
  } catch (_e) {
    // Connect failed despite a successful probe (race). Stay in poll mode.
    state.pushSub = null;
    state.mode = 'poll';
    return false;
  }
}

function leavePush(state) {
  if (state.pushSub) {
    try { state.pushSub.close(); } catch (_e) { /* ignore */ }
    state.pushSub = null;
  }
  state.mode = 'poll';
  state.transitionCount++;
}

// ---------------------------------------------------------------------------

function buildHandle(state, cfg) {
  return {
    /** Current delivery mode — observable. */
    get mode() { return state.mode; },
    get isClosed() { return state.closed; },
    get transitionCount() { return state.transitionCount; },

    /**
     * Manual close. Subsequent iterator steps return done:true.
     */
    close() {
      if (state.closed) return;
      state.closed = true;
      if (state.pushSub) {
        try { state.pushSub.close(); } catch (_e) { /* ignore */ }
      }
      if (state.sleeper) state.sleeper.cancel();
    },

    /**
     * Async iterable contract. One frame at a time. Each frame is ack'd
     * BEFORE control returns to the caller's loop, so the v1 cursor stays
     * monotonically advanced.
     */
    async *[Symbol.asyncIterator]() {
      while (!state.closed) {
        if (state.mode === 'push' && state.pushSub) {
          // Catch-up drain: a push connection only delivers notifies that
          // arrive AFTER the connection. Events emitted while we were in
          // poll mode (or whose notifyEmit() raced daemon startup) are
          // already in SQLite but won't be re-broadcast. Drain them via
          // poll first, then stream push.
          for (const ev of safePoll(cfg)) {
            if (state.closed) return;
            persistAck(cfg.db, cfg.cursor_id, ev.event_id);
            try { state.pushSub.ack(ev.event_id); } catch (_e) { /* ignore */ }
            yield ev;
          }

          for await (const frame of state.pushSub) {
            if (state.closed) return;

            const event = frame.event !== null
              ? frame.event
              : resolveFromLive(cfg.db, frame.event_id);

            if (event) {
              // Ack BEFORE yield: the v1 cursor represents "events handed off
              // to the consumer", not "events the consumer has processed." If
              // the consumer's loop body throws after receiving an event, the
              // cursor has already advanced past it — same trade-off as v1
              // poll() + caller-ack semantics, but eager so the ack durably
              // lands even if the caller stops iterating mid-stream.
              persistAck(cfg.db, cfg.cursor_id, event.event_id);
              try { state.pushSub.ack(event.event_id); } catch (_e) { /* ignore */ }
              yield event;
            }
          }
          // pushSub iterator ended → degrade or socket close. Drop to poll.
          if (!state.closed) leavePush(state);
        }

        if (state.closed) return;

        // Poll mode: drain a batch, sleep, optionally re-probe.
        const batch = safePoll(cfg);
        for (const ev of batch) {
          if (state.closed) return;
          persistAck(cfg.db, cfg.cursor_id, ev.event_id);
          yield ev;
        }

        if (state.closed) return;

        // Re-probe if enabled and interval has passed. We probe even when
        // events were just drained, because long busy-poll runs would
        // otherwise never re-check the daemon.
        if (cfg.auto_recover && shouldReprobe(state, cfg)) {
          state.lastProbeAt = Date.now();
          if (await probeDaemon(cfg.dataDir, cfg.probe_timeout_ms)) {
            await tryEnterPush(state, cfg);
            continue;                // back to top of outer while
          }
        }

        // No new events → sleep before next poll.
        if (batch.length === 0) {
          await sleep(state, cfg.poll_interval_ms);
        }
      }
    },
  };
}

function shouldReprobe(state, cfg) {
  return Date.now() - state.lastProbeAt >= cfg.reprobe_interval_ms;
}

function resolveFromLive(db, eventId) {
  return db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) || null;
}

function persistAck(db, cursorId, eventId) {
  try {
    ack(db, cursorId, eventId);
  } catch (_e) {
    // ack() throws WB-006 on missing cursor. We log nothing here because
    // the subscriber loop's responsibility is delivery; cursor lifecycle
    // is the caller's. A swallowed ack does not lose data — the next
    // iteration will hit the same WB error and surface it.
  }
}

function safePoll(cfg) {
  try {
    return poll(cfg.db, cfg.cursor_id, { batchSize: 100 });
  } catch (e) {
    // Re-throw unrecognized errors; let v1 handle WB-003/WB-006 etc.
    if (e && typeof e.error === 'string' && e.error.startsWith('WB-')) throw e;
    throw e;
  }
}

/**
 * Cancellable sleep. Allows close() to interrupt a long poll-interval wait.
 */
function sleep(state, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      state.sleeper = null;
      resolve();
    }, ms);
    state.sleeper = {
      cancel() {
        clearTimeout(t);
        state.sleeper = null;
        resolve();
      },
    };
  });
}
