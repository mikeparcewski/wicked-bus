/**
 * UI server tests — bind enforcement, bearer auth, origin restriction,
 * read-only verbs, and the v2.0 endpoint set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { startUiServer, TOKEN_FILENAME } from '../../lib/ui-server.js';
import { withContext } from '../../lib/causality.js';
import { put as casPut } from '../../lib/cas.js';

const isWindows = platform() === 'win32';

function get(host, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path, method: 'GET', headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
        json: () => JSON.parse(body),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function method(host, port, verb, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: verb, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------

describe('ui-server — security contract', () => {
  let tmpDir;
  let originalEnv;
  let db;
  let ui;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-ui-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    db = openDb();
  });

  afterEach(async () => {
    if (ui) { try { await ui.stop(); } catch (_e) { /* ignore */ } ui = null; }
    try { db.close(); } catch (_e) { /* ignore */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------

  it('binds to 127.0.0.1 by default', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    expect(ui.host).toBe('127.0.0.1');
    expect(ui.port).toBeGreaterThan(0);
  });

  it('writes a token file with mode 0600 (POSIX)', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const stat = fs.statSync(join(tmpDir, TOKEN_FILENAME));
    if (!isWindows) {
      // Lower permission bits should be 600
      expect((stat.mode & 0o777)).toBe(0o600);
    }
    expect(typeof ui.token).toBe('string');
    expect(ui.token.length).toBeGreaterThan(20);
  });

  it('reuses the existing token across restarts', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const t1 = ui.token;
    await ui.stop();
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    expect(ui.token).toBe(t1);
  });

  it('rotates the token when rotate_token: true', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const t1 = ui.token;
    await ui.stop();
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db, rotate_token: true });
    expect(ui.token).not.toBe(t1);
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('healthz is public (no auth required)', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const res = await get(ui.host, ui.port, '/healthz');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns 401 without a bearer token', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const res = await get(ui.host, ui.port, '/api/info');
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong bearer token', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const res = await get(ui.host, ui.port, '/api/info', { Authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer token', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const res = await get(ui.host, ui.port, '/api/info', { Authorization: `Bearer ${ui.token}` });
    expect(res.status).toBe(200);
    const info = res.json();
    expect(info.bind_host).toBe('127.0.0.1');
    expect(info.token_present).toBe(true);
  });

  it('refuses Origins that do not match the bound host', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const res = await get(ui.host, ui.port, '/api/info', {
      Authorization: `Bearer ${ui.token}`,
      Origin: 'https://evil.example.com',
    });
    expect(res.status).toBe(403);
  });

  it('rejects mutating verbs with 405', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await method(ui.host, ui.port, verb, '/api/info', {
        Authorization: `Bearer ${ui.token}`,
      });
      expect(res.status).toBe(405);
    }
  });

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  it('GET /api/events returns recent events with filtering', async () => {
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    emit(db, config, { event_type: 'wicked.x.fired', domain: 'd', payload: { n: 1 } });
    emit(db, config, { event_type: 'wicked.y.fired', domain: 'd', payload: { n: 2 } });
    emit(db, config, { event_type: 'wicked.x.fired', domain: 'd', payload: { n: 3 } });

    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });

    const allRes = await get(
      ui.host, ui.port, '/api/events?limit=10',
      { Authorization: `Bearer ${ui.token}` },
    );
    expect(allRes.status).toBe(200);
    expect(allRes.json().count).toBe(3);

    const xRes = await get(
      ui.host, ui.port, '/api/events?event_type=wicked.x.fired',
      { Authorization: `Bearer ${ui.token}` },
    );
    expect(xRes.json().count).toBe(2);
  });

  it('GET /api/trace/:cid returns ancestry events for a correlation_id', async () => {
    const config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    withContext({ correlation_id: 'req-trace' }, () => {
      emit(db, config, { event_type: 'wicked.x.fired', domain: 'd', payload: {} });
      emit(db, config, { event_type: 'wicked.x.fired', domain: 'd', payload: {} });
      emit(db, config, { event_type: 'wicked.x.fired', domain: 'd', payload: {} });
    });
    emit(db, config, { event_type: 'wicked.unrelated.thing', domain: 'd', payload: {} });

    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });

    const res = await get(
      ui.host, ui.port, '/api/trace/req-trace',
      { Authorization: `Bearer ${ui.token}` },
    );
    expect(res.status).toBe(200);
    const out = res.json();
    expect(out.correlation_id).toBe('req-trace');
    expect(out.count).toBe(3);
    // Ancestry chain: each subsequent event references the previous via parent_event_id
    expect(out.events[1].parent_event_id).toBe(out.events[0].event_id);
    expect(out.events[2].parent_event_id).toBe(out.events[1].event_id);
  });

  it('GET /api/cas/stats reports object_count and total_bytes', async () => {
    casPut(tmpDir, 'one');
    casPut(tmpDir, 'two');

    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const res = await get(
      ui.host, ui.port, '/api/cas/stats',
      { Authorization: `Bearer ${ui.token}` },
    );
    expect(res.status).toBe(200);
    const out = res.json();
    expect(out.object_count).toBe(2);
    expect(out.total_bytes).toBe(6);
  });

  it('GET /api/buckets returns warm buckets when present', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const empty = await get(
      ui.host, ui.port, '/api/buckets',
      { Authorization: `Bearer ${ui.token}` },
    );
    expect(empty.json().count).toBe(0);
  });

  it('returns 404 for unknown paths', async () => {
    ui = await startUiServer({ dataDir: tmpDir, liveDb: db });
    const res = await get(
      ui.host, ui.port, '/api/totally-not-here',
      { Authorization: `Bearer ${ui.token}` },
    );
    expect(res.status).toBe(404);
  });
});
