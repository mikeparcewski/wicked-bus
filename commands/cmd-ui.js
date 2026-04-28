/**
 * `wicked-bus ui` — operator-facing CLI for the read-only UI server.
 *
 *   wicked-bus ui                 start in foreground, JSON to stdout
 *   wicked-bus ui --detached      fork a child, print connection info, exit 0
 *   wicked-bus ui --rotate-token  regenerate the bearer token
 *   wicked-bus ui --host 0.0.0.0  bind non-loopback (warning printed)
 *   wicked-bus ui --port 7842     bind a specific port (default 0 = ephemeral
 *                                 in foreground; default 7842 in detached
 *                                 mode so a known port is reachable)
 *
 * Foreground sets up SIGTERM/SIGINT handlers for clean shutdown. Detached
 * redirects child stdio to `<dataDir>/ui.log` so startup failures are
 * diagnosable (same lesson as the daemon CLI: stdio:'ignore' on a long-
 * running spawn hides everything).
 *
 * @module commands/cmd-ui
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, ensureDataDir } from '../lib/paths.js';
import { openDb } from '../lib/db.js';
import { startUiServer, DEFAULT_HOST, DEFAULT_PORT } from '../lib/ui-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export async function cmdUi(args /*, globals */) {
  const dataDir = resolveDataDir();
  ensureDataDir();

  // --no-detach is the inner branch; --detached is the outer fork.
  if (args.detached === true || args['detach'] === true) {
    return startDetached(args, dataDir);
  }

  return startForeground(args, dataDir);
}

// ---------------------------------------------------------------------------

async function startDetached(args, dataDir) {
  const logPath = path.join(dataDir, 'ui.log');
  const logFd = fs.openSync(logPath, 'a');

  // Re-invoke ourselves with --no-detach + a known port so the child can
  // start cleanly and the parent can probe.
  const port = args.port ? String(args.port) : String(DEFAULT_PORT);
  const host = args.host ? String(args.host) : DEFAULT_HOST;

  const childArgs = [
    path.resolve(__dirname, 'cli.js'),
    'ui', '--no-detach',
    '--port', port,
    '--host', host,
  ];
  if (args['rotate-token'] === true || args.rotate_token === true) {
    childArgs.push('--rotate-token');
  }

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
    cwd: dataDir,
  });
  fs.closeSync(logFd);
  child.unref();

  const reachable = await waitForUi(host, port, 5000);
  if (!reachable) {
    let logTail = '';
    try { logTail = fs.readFileSync(logPath, 'utf8').slice(-2000); }
    catch (_e) { /* ignore */ }
    return emitJsonExit({
      error: 'ui-start-timeout',
      message: 'spawned UI did not start listening within 5s',
      log_tail: logTail,
    }, 1);
  }

  return emitJson({
    ok: true,
    mode: 'detached',
    pid: child.pid,
    host,
    port: Number(port),
  });
}

// ---------------------------------------------------------------------------

async function startForeground(args, dataDir) {
  const liveDb = openDb();
  const ui = await startUiServer({
    dataDir,
    liveDb,
    host: args.host ?? DEFAULT_HOST,
    port: args.port != null ? Number(args.port) : DEFAULT_PORT,
    rotate_token: args['rotate-token'] === true || args.rotate_token === true,
  });

  const shutdown = async () => {
    try { await ui.stop(); } catch (_e) { /* ignore */ }
    try { liveDb.close(); } catch (_e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);

  emitJson({
    ok: true,
    mode: 'foreground',
    pid: process.pid,
    host: ui.host,
    port: ui.port,
    token_path: ui.token_path,
  });
}

// ---------------------------------------------------------------------------

async function waitForUi(host, port, timeoutMs) {
  const http = await import('node:http');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(http.default, host, port)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

function ping(http, host, port) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/healthz', method: 'GET', timeout: 200 }, (res) => {
      // Drain so the connection releases.
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitJsonExit(obj, code) {
  process.stderr.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}
