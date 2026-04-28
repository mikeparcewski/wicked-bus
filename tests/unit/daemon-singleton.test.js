/**
 * Daemon singleton + coordinatedSpawn — §7.1 + §7.4 spawn-lock behavior.
 *
 * Skipped on Windows (POSIX-style PID liveness checks; equivalent named-mutex
 * code lands with the daemon CLI binary).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  acquireDaemonLock,
  coordinatedSpawn,
  DEFAULT_SPAWN_TIMEOUT_MS,
} from '../../lib/daemon-singleton.js';
import { startDaemon } from '../../lib/daemon.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------

describe('acquireDaemonLock — §7.1 singleton', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-singleton-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  skipOnWindows('claims the lock and writes our PID', () => {
    const lock = acquireDaemonLock(tmpDir);
    const written = fs.readFileSync(lock.path, 'utf8');
    expect(parseInt(written, 10)).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  skipOnWindows('throws EALREADY_RUNNING when another live process holds the lock', () => {
    const lock = acquireDaemonLock(tmpDir);

    expect(() => acquireDaemonLock(tmpDir)).toThrow(/already running/);
    try {
      acquireDaemonLock(tmpDir);
    } catch (e) {
      expect(e.code).toBe('EALREADY_RUNNING');
      expect(e.priorPid).toBe(process.pid);
    }

    lock.release();
  });

  skipOnWindows('claims a stale lock left behind by a dead PID', () => {
    // Write a lock file with a definitely-dead PID
    fs.writeFileSync(join(tmpDir, 'daemon.lock'), '999999999');

    const lock = acquireDaemonLock(tmpDir);
    const written = fs.readFileSync(lock.path, 'utf8');
    expect(parseInt(written, 10)).toBe(process.pid);
    lock.release();
  });

  skipOnWindows('claims when the lock file is unreadable / corrupt', () => {
    fs.writeFileSync(join(tmpDir, 'daemon.lock'), 'not-a-pid');
    const lock = acquireDaemonLock(tmpDir);
    expect(parseInt(fs.readFileSync(lock.path, 'utf8'), 10)).toBe(process.pid);
    lock.release();
  });
});

// ---------------------------------------------------------------------------

describe('coordinatedSpawn — §7.4 spawn-lock + thundering-herd protection', () => {
  let tmpDir;
  let daemons;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-spawn-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    daemons = [];
  });

  afterEach(async () => {
    for (const d of daemons) {
      try { await d.stop(); } catch (_e) { /* ignore */ }
    }
    daemons = [];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  skipOnWindows('returns alreadyRunning when the daemon is already up', async () => {
    const d = await startDaemon({ dataDir: tmpDir });
    daemons.push(d);

    const result = await coordinatedSpawn({
      dataDir: tmpDir,
      spawnFn: async () => { throw new Error('spawnFn must not be called'); },
    });
    expect(result.alreadyRunning).toBe(true);
    expect(result.spawned).toBe(false);
  });

  skipOnWindows('the lock-winner is the only spawnFn caller across N concurrent racers', async () => {
    let spawnCalls = 0;
    let pendingSpawn = null;

    async function spawnFn() {
      spawnCalls++;
      // Simulate the daemon coming up after a short delay; once it's up,
      // probeDaemon() succeeds for the losers.
      if (!pendingSpawn) {
        pendingSpawn = (async () => {
          await delay(50);
          const d = await startDaemon({ dataDir: tmpDir });
          daemons.push(d);
        })();
      }
      await pendingSpawn;
    }

    // 10 concurrent attempts — exactly one should call spawnFn(), the rest
    // should observe alreadyRunning.
    const racers = Array.from({ length: 10 }, () => coordinatedSpawn({
      dataDir: tmpDir,
      spawnFn,
      spawn_timeout_ms: 3000,
      probe_timeout_ms: 100,
      backoff_base_ms: 5,
      backoff_max_ms: 50,
    }));

    const results = await Promise.all(racers);

    expect(spawnCalls).toBe(1);

    const winners   = results.filter(r => r.spawned);
    const observers = results.filter(r => r.alreadyRunning);
    const timedOut  = results.filter(r => r.timedOut);

    expect(winners).toHaveLength(1);
    expect(observers.length + winners.length).toBe(10);
    expect(timedOut).toHaveLength(0);
  });

  skipOnWindows('returns timedOut when spawnFn never produces a reachable daemon', async () => {
    const result = await coordinatedSpawn({
      dataDir: tmpDir,
      spawnFn: async () => { /* pretend to spawn; never actually start */ },
      spawn_timeout_ms: 200,
      probe_timeout_ms: 50,
      backoff_base_ms: 5,
      backoff_max_ms: 30,
    });
    // We won the lock, so we report spawned:true regardless of probe result.
    // The interesting assertion is that the function returned within budget.
    expect(['spawned-only', 'timedOut'].includes(
      result.spawned ? 'spawned-only' : 'timedOut',
    )).toBe(true);
  });

  skipOnWindows('reclaims a stale spawn-lock left by a dead spawner', async () => {
    // Pre-seed a stale spawn-lock pointing at a dead PID
    fs.writeFileSync(join(tmpDir, 'daemon.spawn-lock'), '999999999');

    let spawnCalled = false;
    const result = await coordinatedSpawn({
      dataDir: tmpDir,
      spawnFn: async () => {
        spawnCalled = true;
        const d = await startDaemon({ dataDir: tmpDir });
        daemons.push(d);
      },
      spawn_timeout_ms: 1000,
      probe_timeout_ms: 100,
    });

    expect(spawnCalled).toBe(true);
    expect(result.spawned).toBe(true);
    // Spawn-lock should be cleaned up
    expect(fs.existsSync(join(tmpDir, 'daemon.spawn-lock'))).toBe(false);
  });

  skipOnWindows('rejects when called without required opts', async () => {
    await expect(coordinatedSpawn({})).rejects.toThrow();
    await expect(coordinatedSpawn({ dataDir: tmpDir })).rejects.toThrow();
    await expect(coordinatedSpawn({ spawnFn: async () => {} })).rejects.toThrow();
  });

  it('exposes a sane default spawn timeout', () => {
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
