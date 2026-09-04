/**
 * Periodic WAL checkpoint -- keeps bus.db-wal from outgrowing bus.db.
 *
 * Nothing else TRUNCATE-checkpoints the bus database: emitters are short-lived
 * CLI processes, subscribers hold long-lived read cursors, and SQLite's passive
 * auto-checkpoints keep deferring while those readers ride the WAL. This module
 * runs `PRAGMA wal_checkpoint(TRUNCATE)` on the bus's own connection on a quiet
 * interval, busy-tolerantly: a `busy` result just defers to the next tick (it
 * never blocks the event loop and never errors for that), and the
 * `wal_autocheckpoint` bound applied in lib/db.js is the backstop in between.
 *
 * Mirrors lib/sweep.js: `runCheckpoint` is the single pass, `startCheckpoint`
 * the interval wrapper (cleared by the caller on shutdown, unref'd so it never
 * holds the process open).
 *
 * @module lib/checkpoint
 */

/**
 * Run a single checkpoint pass on `db`'s own connection.
 *
 * Two phases, neither of which can stall the (synchronous) better-sqlite3 call:
 * 1. PASSIVE -- copies every WAL frame that precedes the oldest live reader
 *    mark; by definition it never invokes the busy handler.
 * 2. TRUNCATE -- completes only when no reader still rides the WAL. The
 *    connection's busy_timeout is temporarily zeroed (and restored) so a live
 *    reader makes the pragma return `busy: 1` immediately instead of blocking
 *    the event loop for the full busy timeout.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ busy: boolean, log: number, checkpointed: number }}
 *   `busy: true` means a concurrent reader deferred the truncate -- not an
 *   error; the next tick tries again. `log`/`checkpointed` are the WAL frame
 *   counts from the TRUNCATE row (-1 when the db is not in WAL mode).
 */
export function runCheckpoint(db) {
  // better-sqlite3 `.pragma('busy_timeout')` returns [{ timeout: n }].
  const prev = db.pragma('busy_timeout', { simple: true });
  db.pragma('busy_timeout = 0');
  try {
    db.pragma('wal_checkpoint(PASSIVE)', { simple: false });
    const rows = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : {};
    return {
      busy: row.busy === 1,
      log: typeof row.log === 'number' ? row.log : -1,
      checkpointed: typeof row.checkpointed === 'number' ? row.checkpointed : -1,
    };
  } finally {
    // Restore the caller's busy timeout on every path (openDb sets 5000).
    db.pragma(`busy_timeout = ${Number(prev) || 5000}`);
  }
}

/**
 * Start a background checkpoint interval (`config.checkpoint_interval_minutes`,
 * default 5; `0` disables). The handle is unref'd so an idle checkpoint timer
 * never keeps the process alive; callers still `clearInterval` it on shutdown
 * (same lifecycle as `startSweep`). Checkpoint errors are non-fatal, matching
 * the sweep interval's policy.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @returns {NodeJS.Timeout|null} The interval handle, or null when disabled.
 */
export function startCheckpoint(db, config) {
  if (!config.checkpoint_interval_minutes || config.checkpoint_interval_minutes === 0) {
    return null;
  }

  const intervalMs = config.checkpoint_interval_minutes * 60_000;
  const handle = setInterval(() => {
    try {
      runCheckpoint(db);
    } catch (_) {
      // Checkpoint errors are non-fatal -- a busy WAL simply defers anyway.
    }
  }, intervalMs);
  // Don't keep the event loop alive for checkpoints alone (lagTimer precedent).
  if (handle.unref) handle.unref();
  return handle;
}
