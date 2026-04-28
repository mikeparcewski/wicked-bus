/**
 * `wicked-bus daemon <subcommand>` — start, stop, status.
 *
 * - `start [--detached]`   spawn the daemon in this process or detach a child
 * - `stop`                 send SIGTERM to the running daemon (clean shutdown)
 * - `status`               JSON snapshot: socket path, pid, subscribers
 *
 * Lifecycle uses lib/daemon-singleton.js for the PID lock and
 * lib/daemon.js for the socket server. Subscribers connect via the
 * library / wrapper APIs; this CLI is operator-facing only.
 *
 * @module commands/cmd-daemon
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, ensureDataDir } from '../lib/paths.js';
import {
  startDaemon,
  socketPath,
} from '../lib/daemon.js';
import {
  acquireDaemonLock,
} from '../lib/daemon-singleton.js';
import { probeDaemon } from '../lib/daemon-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export async function cmdDaemon(args, globals, positional) {
  const sub = (positional && positional[0]) || null;
  if (!sub) {
    return emitJson({
      error: 'usage',
      message: 'daemon requires a subcommand: start | stop | status',
    });
  }

  switch (sub) {
    case 'start':  return cmdDaemonStart(args, globals);
    case 'stop':   return cmdDaemonStop(args, globals);
    case 'status': return cmdDaemonStatus(args, globals);
    default:
      return emitJson({
        error: 'usage',
        message: `unknown daemon subcommand: ${sub}`,
      });
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function cmdDaemonStart(args /*, globals */) {
  const dataDir = resolveDataDir();
  ensureDataDir();

  // Detached: fork ourselves with `--no-detach` so the child runs the
  // foreground branch. Parent waits for the socket to come up, prints
  // status, exits 0. Stderr is captured to a log file in dataDir so the
  // child's startup errors are diagnosable even when stdio is detached.
  if (args.detached !== false && (args.detached === true || args['detach'] === true)) {
    const logPath = path.join(dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, 'cli.js'), 'daemon', 'start', '--no-detach'],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
        cwd: dataDir,
      },
    );
    fs.closeSync(logFd);
    child.unref();

    const ok = await waitForSocket(dataDir, 5000);
    if (!ok) {
      let logTail = '';
      try { logTail = fs.readFileSync(logPath, 'utf8').slice(-2000); }
      catch (_e) { /* ignore */ }
      return emitJsonExit({
        error: 'daemon-start-timeout',
        message: 'spawned daemon did not start listening within 5s',
        socket: socketPath(dataDir),
        log_tail: logTail,
      }, 1);
    }
    return emitJson({
      ok: true,
      mode: 'detached',
      pid: child.pid,
      socket: socketPath(dataDir),
    });
  }

  // Foreground: hold the lock, run the daemon, hand off to a SIGTERM/SIGINT
  // handler for clean shutdown. This branch is what `--detached` re-enters.
  let lock;
  try {
    lock = acquireDaemonLock(dataDir);
  } catch (e) {
    if (e.code === 'EALREADY_RUNNING') {
      return emitJsonExit({
        error: 'EALREADY_RUNNING',
        message: e.message,
        prior_pid: e.priorPid,
        socket: socketPath(dataDir),
      }, 1);
    }
    throw e;
  }

  const daemon = await startDaemon({
    dataDir,
    inline_payload_max_bytes: numFlag(args, 'inline-payload-max-bytes'),
    subscriber_queue_max:     numFlag(args, 'subscriber-queue-max'),
  });

  const shutdown = async () => {
    try { await daemon.stop(); } catch (_e) { /* ignore */ }
    try { lock.release(); } catch (_e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);

  emitJson({
    ok: true,
    mode: 'foreground',
    pid: process.pid,
    socket: daemon.socketPath,
  });

  // Stay alive until a signal fires shutdown(). The Node event loop keeps
  // the process running because the server holds an active handle.
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function cmdDaemonStop(/* args, globals */) {
  const dataDir = resolveDataDir();
  const lockPath = path.join(dataDir, 'daemon.lock');

  let pid;
  try {
    pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10) || null;
  } catch (_e) {
    pid = null;
  }

  if (!pid) {
    return emitJson({ ok: false, reason: 'no-lock-file', socket: socketPath(dataDir) });
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return emitJsonExit({
      error: 'kill-failed',
      pid,
      message: e.message,
    }, 1);
  }

  // Best-effort wait for the daemon to release the lock.
  const released = await waitForLockRelease(lockPath, 5000);
  return emitJson({
    ok: true,
    pid,
    released,
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdDaemonStatus(/* args, globals */) {
  const dataDir = resolveDataDir();
  const lockPath = path.join(dataDir, 'daemon.lock');
  const sockPath = socketPath(dataDir);

  let pid = null;
  try { pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10) || null; }
  catch (_e) { /* no lock */ }

  const reachable = await probeDaemon(dataDir, 200);

  return emitJson({
    socket: sockPath,
    lock_path: lockPath,
    pid,
    reachable,
  });
}

// ---------------------------------------------------------------------------

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitJsonExit(obj, code) {
  process.stderr.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function numFlag(args, name) {
  const v = args[name];
  if (v == null || v === true) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function waitForSocket(dataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon(dataDir, 100)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

async function waitForLockRelease(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(lockPath)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
