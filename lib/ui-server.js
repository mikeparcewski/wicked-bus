/**
 * Read-only embedded UI server — DESIGN-v2.md §7.5.
 *
 * Security contract (round-1 council fix):
 *   - Default bind address: 127.0.0.1. Non-loopback `--host` is opt-in and
 *     prints a warning at startup.
 *   - Auth: bearer token in `Authorization` header. Token file is created
 *     with O_CREAT|O_EXCL, mode 0600, owner = current user. Existing token
 *     reused (browser-bookmark friendly). Wrong-UID owner aborts with WB-011.
 *   - No cookie session, no CORS preflight, no query-string token.
 *   - Origin restriction: requests with an Origin header that does not match
 *     the bound host are refused.
 *   - Read-only: every endpoint is a GET; mutating verbs return 405.
 *
 * Endpoints:
 *   GET /healthz            — { ok: true }, no auth required
 *   GET /api/info           — bind / pid / token-presence summary
 *   GET /api/events         — query the live tier (filter by event_type/domain
 *                             /correlation_id/session_id, paginated by event_id)
 *   GET /api/trace/:cid     — full ancestry / descendants for a correlation_id
 *   GET /api/cas/stats      — { object_count, total_bytes }
 *   GET /api/buckets        — list of warm buckets with min/max event_id
 *   GET /api/stream         — SSE stream of `wicked.bus.*` notifies (planned;
 *                             not in v2.0 spike)
 *
 * @module lib/ui-server
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WBError } from './errors.js';
import { archiveDir, listBuckets, getBucketMeta } from './archive.js';
import { stats as casStats } from './cas.js';

export const DEFAULT_HOST       = '127.0.0.1';
export const DEFAULT_PORT       = 7842;
export const TOKEN_FILENAME     = 'ui-token';

/**
 * Start the UI HTTP server.
 *
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {import('better-sqlite3').Database} opts.liveDb
 * @param {string} [opts.host]
 * @param {number} [opts.port=0]            0 = ephemeral (test-friendly)
 * @param {boolean} [opts.rotate_token=false]
 * @returns {Promise<UiHandle>}
 */
export async function startUiServer(opts) {
  const dataDir = mustHave(opts, 'dataDir');
  const liveDb  = mustHave(opts, 'liveDb');
  const host    = opts.host ?? DEFAULT_HOST;
  const port    = opts.port ?? 0;

  const token = ensureToken(dataDir, { rotate: !!opts.rotate_token });

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { dataDir, liveDb, token, host });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (host !== '127.0.0.1' && host !== 'localhost') {
        process.stderr.write(JSON.stringify({
          level: 'warn',
          domain: 'wicked-bus.ui',
          message: `UI bound to non-loopback host: ${host}`,
        }) + '\n');
      }
      resolve({
        host: addr.address,
        port: addr.port,
        token,
        token_path: path.join(dataDir, TOKEN_FILENAME),
        async stop() {
          await new Promise(r => server.close(() => r()));
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Token management — O_CREAT|O_EXCL, mode 0600, UID-aware
// ---------------------------------------------------------------------------

function ensureToken(dataDir, { rotate }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, TOKEN_FILENAME);

  if (fs.existsSync(tokenPath)) {
    if (!rotate) {
      verifyTokenOwnership(tokenPath);
      return fs.readFileSync(tokenPath, 'utf8').trim();
    }
    // rotate: remove and rewrite below
    try { fs.unlinkSync(tokenPath); } catch (_e) { /* ignore */ }
  }

  const token = randomBytes(32).toString('hex');
  // O_CREAT | O_EXCL with mode 0600 — fails if the file came back since.
  const fd = fs.openSync(tokenPath, 'wx', 0o600);
  fs.writeSync(fd, token);
  fs.closeSync(fd);
  return token;
}

function verifyTokenOwnership(tokenPath) {
  let stat;
  try { stat = fs.statSync(tokenPath); }
  catch (_e) { return; }                                                  // disappeared — caller will recreate

  // On POSIX, getuid() is available; on Windows it returns undefined.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid != null && stat.uid !== uid) {
    throw new WBError('WB-011', 'UI_TOKEN_PERMISSION_MISMATCH', {
      message: `UI token at ${tokenPath} is owned by another UID (${stat.uid}); expected ${uid}`,
      path: tokenPath,
      owner_uid: stat.uid,
      expected_uid: uid,
    });
  }
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(req, res, ctx) {
  // Read-only API: only GET / HEAD allowed
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method-not-allowed', method: req.method });
  }

  // Origin restriction. Browsers always set Origin on cross-origin GET
  // (via fetch w/ credentials etc.); CLIs and curl have no Origin.
  const origin = req.headers.origin;
  if (origin && !originAllowed(origin, ctx.host, req)) {
    return sendJson(res, 403, { error: 'origin-not-allowed', origin });
  }

  // Public endpoints (no auth)
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  // All others require a bearer token
  if (!authorized(req, ctx.token)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  switch (url.pathname) {
    case '/api/info':         return apiInfo(res, ctx);
    case '/api/events':       return apiEvents(req, res, url, ctx);
    case '/api/cas/stats':    return apiCasStats(res, ctx);
    case '/api/buckets':      return apiBuckets(res, ctx);
    default:
      if (url.pathname.startsWith('/api/trace/')) {
        return apiTrace(res, url.pathname.slice('/api/trace/'.length), ctx);
      }
      return sendJson(res, 404, { error: 'not-found', path: url.pathname });
  }
}

function authorized(req, token) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const sent = header.slice('Bearer '.length).trim();
  return sent === token;
}

function originAllowed(origin, host /*, req */) {
  // Allow any same-host origin. We don't strictly enforce port match — the
  // UI is locally-bound and the operator chose to expose it.
  try {
    const parsed = new URL(origin);
    return parsed.hostname === host || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Endpoint implementations
// ---------------------------------------------------------------------------

function apiInfo(res, ctx) {
  return sendJson(res, 200, {
    bind_host: ctx.host,
    pid: process.pid,
    data_dir: ctx.dataDir,
    token_present: true,
    version: 'v2.0',
  });
}

function apiEvents(req, res, url, ctx) {
  const filter = {};
  for (const k of ['event_type', 'domain', 'subdomain', 'correlation_id', 'session_id']) {
    const v = url.searchParams.get(k);
    if (v) filter[k] = v;
  }
  const limit = clampInt(url.searchParams.get('limit'), 1, 1000, 100);
  const sinceEventId = parseIntOrZero(url.searchParams.get('since_event_id'));

  const where = [];
  const params = {};
  for (const [k, v] of Object.entries(filter)) {
    where.push(`${k} = @${k}`);
    params[k] = v;
  }
  where.push('event_id > @since_event_id');
  params.since_event_id = sinceEventId;

  const sql = `
    SELECT event_id, event_type, domain, subdomain, payload,
           emitted_at, correlation_id, session_id, parent_event_id,
           producer_id, registry_schema_version, payload_cas_sha
    FROM events
    WHERE ${where.join(' AND ')}
    ORDER BY event_id ASC
    LIMIT @limit
  `;
  params.limit = limit;

  const rows = ctx.liveDb.prepare(sql).all(params);
  return sendJson(res, 200, { events: rows, count: rows.length });
}

function apiTrace(res, correlationId, ctx) {
  if (!correlationId) {
    return sendJson(res, 400, { error: 'missing-correlation-id' });
  }
  const rows = ctx.liveDb.prepare(`
    SELECT event_id, event_type, domain, parent_event_id, emitted_at,
           session_id, producer_id
    FROM events
    WHERE correlation_id = ?
    ORDER BY event_id ASC
  `).all(correlationId);

  return sendJson(res, 200, {
    correlation_id: correlationId,
    events: rows,
    count: rows.length,
  });
}

function apiCasStats(res, ctx) {
  return sendJson(res, 200, casStats(ctx.dataDir));
}

function apiBuckets(res, ctx) {
  const archDir = archiveDir(ctx.dataDir);
  const buckets = listBuckets(archDir).map(p => {
    const basename = path.basename(p);
    let meta = {};
    try { meta = getBucketMeta(p); } catch (_e) { /* unreadable */ }
    return {
      filename: basename,
      min_event_id: meta.min_event_id ? Number(meta.min_event_id) : null,
      max_event_id: meta.max_event_id ? Number(meta.max_event_id) : null,
      sealed_at: meta.sealed_at ? Number(meta.sealed_at) : null,
    };
  });
  return sendJson(res, 200, { buckets, count: buckets.length });
}

// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

function mustHave(obj, key) {
  if (!obj || obj[key] == null) throw new Error(`startUiServer requires opts.${key}`);
  return obj[key];
}

function parseIntOrZero(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : 0;
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
