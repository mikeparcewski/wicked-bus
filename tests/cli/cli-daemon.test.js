/**
 * CLI tests for `wicked-bus daemon` — start (detached), status, stop.
 *
 * Skipped on Windows (Unix-socket only in this spike).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { run, CLI } from './helpers.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await delay(50);
  }
  return false;
}

// ---------------------------------------------------------------------------

describe('CLI: wicked-bus daemon', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-daemon-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    // Best-effort: send SIGTERM to anything still holding the lock.
    try { run(['daemon', 'stop'], { dataDir: tmpDir }); } catch (_e) { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  skipOnWindows('daemon status reports unreachable when no daemon is running', () => {
    const { stdout, exitCode } = run(['daemon', 'status'], { dataDir: tmpDir });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.reachable).toBe(false);
    expect(out.pid).toBeNull();
    expect(out.socket).toMatch(/\.sock$/);
  });

  // -------------------------------------------------------------------------

  skipOnWindows('daemon start --detached spawns a child and reports a usable socket', async () => {
    const result = run(['daemon', 'start', '--detached'], { dataDir: tmpDir });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error('daemon start failed', result);
      try {
        // eslint-disable-next-line no-console
        console.error('daemon.log:\n' + (await import('node:fs')).readFileSync(join(tmpDir, 'daemon.log'), 'utf8'));
      } catch (_e) { /* no log */ }
    }
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('detached');
    expect(typeof out.pid).toBe('number');
    expect(out.socket).toMatch(/\.sock$/);

    // status should now report reachable + pid
    const status = JSON.parse(run(['daemon', 'status'], { dataDir: tmpDir }).stdout);
    expect(status.reachable).toBe(true);
    expect(status.pid).toBe(out.pid);
  }, 15000);

  // -------------------------------------------------------------------------

  skipOnWindows('daemon stop sends SIGTERM and reports release', async () => {
    run(['daemon', 'start', '--detached'], { dataDir: tmpDir });
    await waitFor(() =>
      JSON.parse(run(['daemon', 'status'], { dataDir: tmpDir }).stdout).reachable,
    );

    const { stdout, exitCode } = run(['daemon', 'stop'], { dataDir: tmpDir });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(typeof out.pid).toBe('number');
    expect(out.released).toBe(true);

    // status should now report unreachable
    const status = JSON.parse(run(['daemon', 'status'], { dataDir: tmpDir }).stdout);
    expect(status.reachable).toBe(false);
  }, 15000);

  // -------------------------------------------------------------------------

  skipOnWindows('daemon stop reports no-lock-file when nothing is running', () => {
    const { stdout, exitCode } = run(['daemon', 'stop'], { dataDir: tmpDir });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-lock-file');
  });

  // -------------------------------------------------------------------------

  skipOnWindows('starting twice on the same data dir reports EALREADY_RUNNING', async () => {
    // Foreground spawn so we own the lock for the duration of the test.
    // We start it as a child so the parent test process can keep running.
    const child = spawn(
      process.execPath,
      [CLI, 'daemon', 'start', '--no-detach'],
      {
        env: { ...process.env, WICKED_BUS_DATA_DIR: tmpDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Wait for the daemon's socket — its actual path is reported by status.
    const ready = await waitFor(() => {
      const status = JSON.parse(run(['daemon', 'status'], { dataDir: tmpDir }).stdout);
      return status.reachable;
    });
    expect(ready).toBe(true);

    // Second start (also foreground via --no-detach) MUST refuse.
    const { stderr, exitCode } = run(
      ['daemon', 'start', '--no-detach'],
      { dataDir: tmpDir },
    );
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr);
    expect(err.error).toBe('EALREADY_RUNNING');
    expect(typeof err.prior_pid).toBe('number');

    // Clean up the child
    try { child.kill('SIGTERM'); } catch (_e) { /* ignore */ }
    await waitFor(() => !existsSync(join(tmpDir, 'daemon.lock')), 3000);
  }, 15000);

  // -------------------------------------------------------------------------

  skipOnWindows('daemon without a subcommand prints usage', () => {
    const { stdout } = run(['daemon'], { dataDir: tmpDir });
    const out = JSON.parse(stdout);
    expect(out.error).toBe('usage');
    expect(out.message).toMatch(/start.*stop.*status/);
  });

  skipOnWindows('daemon with an unknown subcommand prints usage', () => {
    const { stdout } = run(['daemon', 'bogus'], { dataDir: tmpDir });
    const out = JSON.parse(stdout);
    expect(out.error).toBe('usage');
    expect(out.message).toMatch(/unknown daemon subcommand: bogus/);
  });
});
