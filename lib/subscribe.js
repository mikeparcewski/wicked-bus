/**
 * Managed long-running subscriber helper.
 * @module lib/subscribe
 *
 * Layered on top of register/poll/ack — handles the poll loop, error
 * isolation, retry/backoff, dead-lettering, lifecycle, lag introspection,
 * and replay drain.
 *
 * Design notes:
 * - Serial per subscription: events are processed one at a time in cursor
 *   order. The next poll does not start until the current batch is drained.
 * - Retry state lives in `delivery_attempts` so it survives process restarts.
 *   On the next poll after a crash, the loop reads the existing attempt count
 *   and resumes from where it left off.
 * - On exhaustion, the event is copied (denormalized) into `dead_letters` and
 *   the cursor is acked past it. The original `events` row may be swept by
 *   the 24h `dedup_expires_at` later — the DLQ row is self-contained.
 * - `stop()` cancels any in-flight backoff timer, dead-letters the sleeping
 *   event, and acks the cursor. Cursor cleanliness beats avoiding an
 *   unexpected DLQ entry the operator can replay.
 * - `replayDeadLetter()` sets `replay_requested_at`. The loop drains pending
 *   replays before each normal poll — success deletes the DLQ row, failure
 *   clears `replay_requested_at` and updates `attempts` / `last_error`.
 *
 * Caveats:
 * - At-least-once delivery + retries means the handler may be invoked more
 *   than once for the same logical event. Handlers must be idempotent.
 * - If a DLQ entry is replayed and the handler re-emits as part of recovery,
 *   the original `idempotency_key` may already have been swept from `events`
 *   (24h `dedup_expires_at`). The re-emission will not be deduped against
 *   the original. Replay is for recovery, not for transparent retry.
 */

import { poll, ack } from './poll.js';
import { register } from './register.js';

const DEFAULTS = Object.freeze({
  pollIntervalMs: 15000,
  batchSize: 50,
  maxRetries: 0,
  backoffMs: 1000,
  lagIntervalMs: 60000,
  cursor_init: 'latest',
});

/**
 * Resume an existing subscription by (plugin, filter), or register a new one.
 * Internal — not exported. Direct callers of register() keep the original
 * "always create a new UUID" semantics.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @returns {{ subscription_id: string, cursor_id: string, created: boolean }}
 */
function registerOrResume(db, opts) {
  const existing = db.prepare(`
    SELECT s.subscription_id, c.cursor_id
    FROM subscriptions s
    INNER JOIN cursors c ON c.subscription_id = s.subscription_id
    WHERE s.plugin = ?
      AND s.role = 'subscriber'
      AND s.event_type_filter = ?
      AND s.deregistered_at IS NULL
      AND c.deregistered_at IS NULL
    ORDER BY s.registered_at DESC
    LIMIT 1
  `).get(opts.plugin, opts.filter);

  if (existing) {
    return {
      subscription_id: existing.subscription_id,
      cursor_id: existing.cursor_id,
      created: false,
    };
  }

  const fresh = register(db, {
    plugin: opts.plugin,
    role: 'subscriber',
    filter: opts.filter,
    cursor_init: opts.cursor_init,
  });

  return {
    subscription_id: fresh.subscription_id,
    cursor_id: fresh.cursor_id,
    created: true,
  };
}

/**
 * Normalize backoffMs into an array of length maxRetries with last-element
 * repeat semantics. A single number becomes a constant array.
 */
function normalizeBackoff(input, maxRetries) {
  if (maxRetries <= 0) return [];
  const source = Array.isArray(input) ? input : [input ?? DEFAULTS.backoffMs];
  if (source.length === 0) return new Array(maxRetries).fill(DEFAULTS.backoffMs);
  const out = new Array(maxRetries);
  for (let i = 0; i < maxRetries; i++) {
    out[i] = source[Math.min(i, source.length - 1)];
  }
  return out;
}

/**
 * Read the current attempt count for an in-flight retry, or 0 if none.
 */
function getAttempts(db, cursorId, eventId) {
  const row = db.prepare(
    'SELECT attempts FROM delivery_attempts WHERE cursor_id = ? AND event_id = ?'
  ).get(cursorId, eventId);
  return row ? row.attempts : 0;
}

function upsertDeliveryAttempt(db, cursorId, eventId, attempts, lastError) {
  db.prepare(`
    INSERT INTO delivery_attempts (cursor_id, event_id, attempts, last_attempt_at, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cursor_id, event_id) DO UPDATE SET
      attempts = excluded.attempts,
      last_attempt_at = excluded.last_attempt_at,
      last_error = excluded.last_error
  `).run(cursorId, eventId, attempts, Date.now(), lastError ?? null);
}

function deleteDeliveryAttempt(db, cursorId, eventId) {
  db.prepare(
    'DELETE FROM delivery_attempts WHERE cursor_id = ? AND event_id = ?'
  ).run(cursorId, eventId);
}

function moveToDeadLetter(db, cursorId, subscriptionId, event, attempts, reason) {
  db.prepare(`
    INSERT INTO dead_letters (
      cursor_id, subscription_id, event_id, event_type, domain, subdomain,
      payload, emitted_at, attempts, last_error, dead_lettered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cursorId,
    subscriptionId,
    event.event_id,
    event.event_type,
    event.domain,
    event.subdomain ?? '',
    typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload),
    event.emitted_at,
    attempts,
    reason ?? null,
    Date.now()
  );
}

function parseEvent(row) {
  let payload = row.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { /* leave as string */ }
  }
  return { ...row, payload };
}

/**
 * Compute lag for a cursor — how far behind the head of the matching stream.
 * @returns {{ cursor_lag: number, oldest_unacked_age_ms: number|null, dlq_count: number }}
 */
function computeLag(db, cursorId) {
  const cursor = db.prepare(
    'SELECT * FROM cursors WHERE cursor_id = ?'
  ).get(cursorId);
  if (!cursor) {
    return { cursor_lag: 0, oldest_unacked_age_ms: null, dlq_count: 0 };
  }

  const sub = db.prepare(
    'SELECT * FROM subscriptions WHERE subscription_id = ?'
  ).get(cursor.subscription_id);
  if (!sub) {
    return { cursor_lag: 0, oldest_unacked_age_ms: null, dlq_count: 0 };
  }

  // Reuse poll() filter compilation by counting matching events ahead of cursor.
  // We approximate: count rows where event_id > last_event_id and not expired.
  // Filter matching is handled in a sub-query below.
  const head = db.prepare(
    'SELECT MAX(event_id) as max_id FROM events'
  ).get();
  const maxId = head && head.max_id != null ? head.max_id : 0;
  const cursorLag = Math.max(0, maxId - cursor.last_event_id);

  // Oldest unacked age is best-effort: emitted_at of the lowest unacked event
  // that the cursor would actually receive on next poll. We skip the filter
  // join here for simplicity and use the same filtered poll() shape via
  // event_id > last_event_id and expires_at > now.
  const now = Date.now();
  const oldest = db.prepare(`
    SELECT MIN(emitted_at) as oldest
    FROM events
    WHERE event_id > ? AND expires_at > ?
  `).get(cursor.last_event_id, now);
  const oldestUnackedAgeMs = oldest && oldest.oldest != null ? now - oldest.oldest : null;

  const dlq = db.prepare(
    'SELECT COUNT(*) as c FROM dead_letters WHERE cursor_id = ?'
  ).get(cursorId);
  const dlqCount = dlq ? dlq.c : 0;

  return {
    cursor_lag: cursorLag,
    oldest_unacked_age_ms: oldestUnackedAgeMs,
    dlq_count: dlqCount,
  };
}

/**
 * Subscribe to events with a managed loop, retry, DLQ, and lifecycle.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db - Open DB handle (required)
 * @param {string} opts.plugin - Subscriber plugin identity
 * @param {string} opts.filter - Event type filter (e.g. 'wicked.fact.extracted.*')
 * @param {(event: object) => void|Promise<void>} opts.handler - Event handler; throws to retry
 * @param {'latest'|'oldest'} [opts.cursor_init='latest'] - Only used on first registration
 * @param {number} [opts.pollIntervalMs=15000]
 * @param {number} [opts.batchSize=50]
 * @param {number} [opts.maxRetries=0] - 0 = fail-fast (advance cursor on first failure)
 * @param {number|number[]} [opts.backoffMs=1000] - Number = constant; array repeats last element
 * @param {number} [opts.lagIntervalMs=60000] - onLag callback cadence (independent of poll)
 * @param {(err: Error, event: object) => void} [opts.onError]
 * @param {(event: object, reason: string) => void} [opts.onDeadLetter]
 * @param {(lag: object) => void} [opts.onLag]
 *
 * @returns {{ stop: () => Promise<void>, getLag: () => object, cursor_id: string, subscription_id: string }}
 */
export function subscribe(opts) {
  if (!opts || !opts.db) throw new TypeError('subscribe: opts.db is required');
  if (!opts.plugin) throw new TypeError('subscribe: opts.plugin is required');
  if (!opts.filter) throw new TypeError('subscribe: opts.filter is required');
  if (typeof opts.handler !== 'function') {
    throw new TypeError('subscribe: opts.handler must be a function');
  }

  const db = opts.db;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const backoffMs = normalizeBackoff(opts.backoffMs, maxRetries);
  const lagIntervalMs = opts.lagIntervalMs ?? DEFAULTS.lagIntervalMs;

  const { subscription_id, cursor_id } = registerOrResume(db, {
    plugin: opts.plugin,
    filter: opts.filter,
    cursor_init: opts.cursor_init || DEFAULTS.cursor_init,
  });

  // ── Loop state ────────────────────────────────────────────────────────────
  let stopping = false;
  let stopPromise = null;
  let resolveStop = null;
  let pollTimer = null;
  let lagTimer = null;
  let backoffTimer = null;
  let cancelBackoff = null;
  let loopActive = false;

  function safeCallback(cb, ...args) {
    if (typeof cb !== 'function') return;
    try { cb(...args); } catch (_) { /* user callback errors are swallowed */ }
  }

  function sleepCancelable(ms) {
    return new Promise(resolve => {
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        cancelBackoff = null;
        resolve(true);
      }, ms);
      cancelBackoff = () => {
        if (backoffTimer) {
          clearTimeout(backoffTimer);
          backoffTimer = null;
        }
        cancelBackoff = null;
        resolve(false);
      };
    });
  }

  /**
   * Process a single event with retry/DLQ semantics.
   * Returns true when the cursor was advanced (success or DLQ), false if the
   * loop should bail without advancing (only on shutdown mid-handler).
   */
  async function processEvent(event) {
    let attempts = getAttempts(db, cursor_id, event.event_id);
    const parsed = parseEvent(event);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (stopping && attempts > 0) {
        // Mid-retry shutdown: DLQ and advance.
        moveToDeadLetter(db, cursor_id, subscription_id, event, attempts, 'shutdown during backoff');
        deleteDeliveryAttempt(db, cursor_id, event.event_id);
        ack(db, cursor_id, event.event_id);
        safeCallback(opts.onDeadLetter, parsed, 'shutdown during backoff');
        return true;
      }

      try {
        await opts.handler(parsed);
        deleteDeliveryAttempt(db, cursor_id, event.event_id);
        ack(db, cursor_id, event.event_id);
        return true;
      } catch (err) {
        attempts += 1;
        safeCallback(opts.onError, err, parsed);

        if (attempts > maxRetries) {
          moveToDeadLetter(db, cursor_id, subscription_id, event, attempts, err.message);
          deleteDeliveryAttempt(db, cursor_id, event.event_id);
          ack(db, cursor_id, event.event_id);
          safeCallback(opts.onDeadLetter, parsed, err.message);
          return true;
        }

        upsertDeliveryAttempt(db, cursor_id, event.event_id, attempts, err.message);
        const sleepMs = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
        const completed = await sleepCancelable(sleepMs);
        if (!completed) {
          // stop() interrupted the backoff
          moveToDeadLetter(db, cursor_id, subscription_id, event, attempts, 'shutdown during backoff');
          deleteDeliveryAttempt(db, cursor_id, event.event_id);
          ack(db, cursor_id, event.event_id);
          safeCallback(opts.onDeadLetter, parsed, 'shutdown during backoff');
          return true;
        }
        // loop again — retry handler
      }
    }
  }

  /**
   * Drain pending replays for this cursor before normal polling.
   * Each replay is a single attempt — no retry semantics. Success deletes the
   * DLQ row; failure clears replay_requested_at and updates attempts / last_error.
   */
  async function drainReplays() {
    while (!stopping) {
      const row = db.prepare(`
        SELECT * FROM dead_letters
        WHERE cursor_id = ? AND replay_requested_at IS NOT NULL
        ORDER BY dl_id ASC
        LIMIT 1
      `).get(cursor_id);
      if (!row) return;

      const parsed = parseEvent(row);
      try {
        await opts.handler(parsed);
        db.prepare('DELETE FROM dead_letters WHERE dl_id = ?').run(row.dl_id);
      } catch (err) {
        safeCallback(opts.onError, err, parsed);
        db.prepare(`
          UPDATE dead_letters
          SET replay_requested_at = NULL,
              attempts = attempts + 1,
              last_error = ?
          WHERE dl_id = ?
        `).run(err.message, row.dl_id);
        // Stop draining on failure; operator can re-replay after fixing
        return;
      }
    }
  }

  async function tick() {
    if (stopping || loopActive) return;
    loopActive = true;
    try {
      await drainReplays();
      if (stopping) return;

      const events = poll(db, cursor_id, { batchSize });
      for (const event of events) {
        if (stopping) break;
        await processEvent(event);
      }
    } catch (err) {
      // Polling errors (WB-003, WB-006) bubble through onError so operators
      // see them. The loop continues — the next tick will retry.
      safeCallback(opts.onError, err, null);
    } finally {
      loopActive = false;
      if (!stopping) {
        pollTimer = setTimeout(tick, pollIntervalMs);
      } else if (resolveStop) {
        finalizeStop();
      }
    }
  }

  function finalizeStop() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (lagTimer) { clearInterval(lagTimer); lagTimer = null; }
    if (resolveStop) {
      const r = resolveStop;
      resolveStop = null;
      r();
    }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = new Promise(resolve => { resolveStop = resolve; });

    if (cancelBackoff) cancelBackoff();
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (lagTimer) { clearInterval(lagTimer); lagTimer = null; }

    if (!loopActive) {
      // Nothing in flight — resolve immediately
      finalizeStop();
    }
    // Otherwise tick()'s finally block will resolve once the in-flight handler
    // (or backoff cancellation) completes.

    return stopPromise;
  }

  function getLag() {
    return computeLag(db, cursor_id);
  }

  // ── Start the loop ────────────────────────────────────────────────────────
  // First tick on next macrotask so the caller can attach handlers / store the
  // returned handle before the loop begins.
  pollTimer = setTimeout(tick, 0);

  if (typeof opts.onLag === 'function') {
    lagTimer = setInterval(() => {
      safeCallback(opts.onLag, computeLag(db, cursor_id));
    }, lagIntervalMs);
    // Don't keep the event loop alive for lag callbacks alone
    if (lagTimer.unref) lagTimer.unref();
  }

  return { stop, getLag, cursor_id, subscription_id };
}

// Internal export for testing / advanced callers that want resume semantics
// without the full managed loop.
export { registerOrResume };
