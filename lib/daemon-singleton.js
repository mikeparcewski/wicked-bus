/**
 * Daemon singleton enforcement and spawn thundering-herd protection.
 *
 * §7.1 — uses an exclusive lock on `<dataDir>/daemon.lock` to ensure exactly
 * one daemon process owns the socket. Implementation uses `O_CREAT | O_EXCL`
 * on a sibling `<dataDir>/daemon.spawn-lock` file to coordinate concurrent
 * spawn attempts, plus a non-blocking flock-equivalent on `daemon.lock` for
 * the long-lived singleton. Pure Node — no native flock binding.
 *
 * §7.4 — when N subscribers race to `subscribe()` against a missing daemon,
 * exactly one wins the spawn-lock and starts the daemon; the others wait on
 * jittered exponential backoff and re-probe.
 *
 * @module lib/daemon-singleton
 */

import fs from 'node:fs';
import path from 'node:path';
import { probeDaemon } from './daemon-client.js';

export const DEFAULT_SPAWN_TIMEOUT_MS  = 5000;
export const DEFAULT_BACKOFF_BASE_MS   = 10;
export const DEFAULT_BACKOFF_MAX_MS    = 2000;
export const DEFAULT_BACKOFF_JITTER    = 0.25;

/**
 * Acquire the singleton daemon-lock for the lifetime of the calling process.
 * Returns a release function; throws if another process already holds it.
 *
 * Implementation: write our PID to `<dataDir>/daemon.lock` using O_EXCL.
 * If the file already exists, check if its PID is alive; if not (stale lock
 * from a crashed prior daemon), claim it.
 *
 * @param {string} dataDir
 * @returns {{ release(): void, path: string }}
 */
export function acquireDaemonLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'daemon.lock');

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        path: lockPath,
        release() {
          try { fs.unlinkSync(lockPath); } catch (_e) { /* ignore */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    // Lock file exists. Check whether the prior holder is still alive.
    let priorPid = null;
    try { priorPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10) || null; }
    catch (_e) { /* unreadable — treat as stale */ }

    if (priorPid && pidIsAlive(priorPid)) {
      const err = new Error(`daemon already running (pid=${priorPid})`);
      err.code = 'EALREADY_RUNNING';
      err.priorPid = priorPid;
      throw err;
    }

    // Stale lock → remove and retry. This is safe because the prior process
    // is dead by the time we observe the stale PID.
    try { fs.unlinkSync(lockPath); } catch (_e) { /* concurrent clean-up */ }
  }
}

/**
 * Cooperatively coordinate one-of-many spawn attempts. The function does:
 *   1. Probe the daemon socket. If reachable, return { spawned: false, alreadyRunning: true }.
 *   2. Try to claim `daemon.spawn-lock` via O_CREAT|O_EXCL. If we win:
 *      a. Call `spawnFn()` (caller spawns + waits for socket-readiness).
 *      b. Release the spawn-lock.
 *      c. Return { spawned: true }.
 *   3. If we lose the lock, wait with jittered exponential backoff. Each
 *      iteration we re-probe; once the socket comes up we return
 *      { spawned: false, alreadyRunning: true }.
 *   4. After spawn_timeout_ms with no daemon visible, return { spawned: false, timedOut: true }.
 *
 * @param {object} opts
 * @param {string}   opts.dataDir
 * @param {() => Promise<void>} opts.spawnFn  - caller's spawn-and-wait function
 * @param {number}   [opts.spawn_timeout_ms]
 * @param {number}   [opts.probe_timeout_ms]
 * @returns {Promise<{ spawned: boolean, alreadyRunning?: boolean, timedOut?: boolean }>}
 */
export async function coordinatedSpawn(opts) {
  const dataDir       = opts.dataDir;
  const spawnFn       = opts.spawnFn;
  const spawnTimeout  = opts.spawn_timeout_ms ?? DEFAULT_SPAWN_TIMEOUT_MS;
  const probeTimeout  = opts.probe_timeout_ms ?? 100;
  const baseBackoff   = opts.backoff_base_ms ?? DEFAULT_BACKOFF_BASE_MS;
  const maxBackoff    = opts.backoff_max_ms  ?? DEFAULT_BACKOFF_MAX_MS;
  const jitter        = opts.backoff_jitter  ?? DEFAULT_BACKOFF_JITTER;

  if (!dataDir || typeof spawnFn !== 'function') {
    throw new Error('coordinatedSpawn requires { dataDir, spawnFn }');
  }

  // Fast path: daemon already up
  if (await probeDaemon(dataDir, probeTimeout)) {
    return { spawned: false, alreadyRunning: true };
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const spawnLockPath = path.join(dataDir, 'daemon.spawn-lock');
  const deadline = Date.now() + spawnTimeout;

  // Try to win the spawn-lock
  let weHoldLock = false;
  try {
    const fd = fs.openSync(spawnLockPath, 'wx', 0o600);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    weHoldLock = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Someone else is spawning. Check if their lock is stale.
    if (isSpawnLockStale(spawnLockPath)) {
      try { fs.unlinkSync(spawnLockPath); } catch (_e) { /* ignore */ }
      // Retry once — caller will hit the loser path if another racer claims it.
      try {
        const fd = fs.openSync(spawnLockPath, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        weHoldLock = true;
      } catch (_e2) { /* lost the race again */ }
    }
  }

  if (weHoldLock) {
    try {
      await spawnFn();
      // Don't probe ourselves — caller's spawnFn is responsible for waiting
      // until the daemon socket is connectable.
      return { spawned: true };
    } finally {
      try { fs.unlinkSync(spawnLockPath); } catch (_e) { /* ignore */ }
    }
  }

  // Loser path: jittered exponential backoff while re-probing.
  let attempt = 0;
  while (Date.now() < deadline) {
    if (await probeDaemon(dataDir, probeTimeout)) {
      return { spawned: false, alreadyRunning: true };
    }
    const sleepMs = Math.min(baseBackoff * Math.pow(2, attempt), maxBackoff);
    const jittered = sleepMs * (1 + (Math.random() * 2 - 1) * jitter);
    await sleep(Math.max(1, Math.floor(jittered)));
    attempt++;
  }

  return { spawned: false, timedOut: true };
}

// ---------------------------------------------------------------------------

function pidIsAlive(pid) {
  try {
    // Signal 0 tests whether the process exists without sending an actual signal.
    // Throws ESRCH if the process is gone, EPERM if it exists but we can't signal it.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';   // exists but owned by another user
  }
}

function isSpawnLockStale(lockPath) {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10) || null; }
  catch (_e) { return true; }                  // unreadable → stale
  if (!pid) return true;
  return !pidIsAlive(pid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
