/**
 * CLI tests for `wicked-bus ui` — detached spawn → /healthz reachable, stop
 * via SIGTERM, basic auth flow against a known-port detached server.
 *
 * Skipped on Windows for now (the daemon-CLI Unix-socket tests skip too;
 * the UI itself is HTTP and works there, but the spawn-and-probe pattern
 * is shared with daemon CLI tests).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

const isWindows = platform() === 'win32';
const skipOnWindows = isWindows ? it.skip : it;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function getOnce(host, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await delay(50);
  }
  return false;
}

// Pick a random high port to avoid collisions when running tests in parallel.
function pickPort() {
  return 30000 + Math.floor(Math.random() * 30000);
}

// ---------------------------------------------------------------------------

describe('CLI: wicked-bus ui', () => {
  let tmpDir;
  let port;
  let pid;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-ui-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    port = pickPort();
    pid = null;
  });

  afterEach(async () => {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch (_e) { /* already gone */ }
      await waitFor(async () => {
        try {
          await getOnce('127.0.0.1', port, '/healthz');
          return false;
        } catch (_e) { return true; }
      }, 3000);
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  skipOnWindows('ui --detached spawns a server reachable on /healthz', async () => {
    const { stdout, exitCode } = run(
      ['ui', '--detached', '--port', String(port), '--host', '127.0.0.1'],
      { dataDir: tmpDir },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('detached');
    expect(out.port).toBe(port);
    expect(out.host).toBe('127.0.0.1');
    pid = out.pid;

    const health = await getOnce('127.0.0.1', port, '/healthz');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
  }, 15000);

  skipOnWindows('ui --detached creates a 0600 token file in the data dir', async () => {
    const { stdout } = run(
      ['ui', '--detached', '--port', String(port)],
      { dataDir: tmpDir },
    );
    pid = JSON.parse(stdout).pid;

    await waitFor(() => fs.existsSync(join(tmpDir, 'ui-token')), 3000);
    const stat = fs.statSync(join(tmpDir, 'ui-token'));
    expect((stat.mode & 0o777)).toBe(0o600);
  }, 15000);

  skipOnWindows('ui detached server requires the bearer token for /api/info', async () => {
    const { stdout } = run(
      ['ui', '--detached', '--port', String(port)],
      { dataDir: tmpDir },
    );
    pid = JSON.parse(stdout).pid;
    await waitFor(() => fs.existsSync(join(tmpDir, 'ui-token')), 3000);

    const noAuth = await getOnce('127.0.0.1', port, '/api/info');
    expect(noAuth.status).toBe(401);

    const token = fs.readFileSync(join(tmpDir, 'ui-token'), 'utf8').trim();
    const ok = await getOnce('127.0.0.1', port, '/api/info', {
      Authorization: `Bearer ${token}`,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).bind_host).toBe('127.0.0.1');
  }, 15000);

  skipOnWindows('rejects detached spawn when the port is already in use', async () => {
    // Hold the port with a tiny in-process server, then try to start the UI on it.
    const blocker = http.createServer((_req, res) => res.end()).listen(port, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));

    const { stderr, exitCode } = run(
      ['ui', '--detached', '--port', String(port)],
      { dataDir: tmpDir },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error).toBe('ui-start-timeout');

    await new Promise(r => blocker.close(r));
  }, 15000);
});
