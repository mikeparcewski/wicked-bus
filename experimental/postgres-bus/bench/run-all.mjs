/**
 * Bench orchestrator. MEASUREMENT SPIKE ONLY.
 *
 * Runs every variant serially, twice each (lat = paced ~400/s target for
 * per-event latency; thr = back-to-back for sustained throughput), and
 * prints a results table + writes results.json next to this file.
 *
 * SQLite runs get a fresh THROWAWAY data dir per run (WICKED_BUS_DATA_DIR
 * under os.tmpdir()) — the user's real bus data is never touched.
 * PG runs TRUNCATE the bench tables per run (bus_bench database only).
 *
 * env: PG_URL to override the default postgres://wicked:wicked@localhost:55432/bus_bench
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgBus } from '../src/pg-bus.js';
import { CONN } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAT_COUNT = 2200;   // 200 warm-up + 2000 measured
const WARMUP = 200;
const THR_COUNT = 5000;
const PACE_MS = 2;        // latency-run pacing target (~400-500/s nominal)
const POLL_MS = 25;       // stated tight poll interval for both buses

const results = {};

function spawnScript(script, kv, extraEnv = {}) {
  const argv = Object.entries(kv).map(([k, v]) => `${k}=${v}`);
  const child = spawn(process.execPath, [join(HERE, script), ...argv], {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.setEncoding('utf8');
  return child;
}

function waitReady(child, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: no READY within ${timeoutMs}ms`)), timeoutMs);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('READY')) { clearTimeout(t); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`${label}: exited early (${code})`)); });
  });
}

function waitExit(child, label, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    // The child may have exited before this listener attaches (e.g. the push
    // consumer finishes before the emitter's post-loop flush sleep) — 'exit'
    // will never re-fire, so check the recorded state first.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${label}: timeout`)); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function throughput(consumer, emitter) {
  const span = (consumer.last_recv_t - emitter.first_emit_t) / 1000;
  return Math.round((consumer.received / span) * 10) / 10;
}

// ── SQLite runs ─────────────────────────────────────────────────────────────

async function sqliteRun(mode, run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-bench-'));
  const env = { WICKED_BUS_DATA_DIR: dataDir };
  const cRes = join(dataDir, 'consumer.json');
  const eRes = join(dataDir, 'emitter.json');
  const count = run === 'lat' ? LAT_COUNT : THR_COUNT;

  let daemon = null;
  try {
    if (mode === 'push') {
      daemon = spawnScript('sqlite-daemon.mjs', {}, env);
      await waitReady(daemon, 'sqlite-daemon');
    }

    const consumer = spawnScript('sqlite-consumer.mjs', {
      mode, expect: count, warmup: run === 'lat' ? WARMUP : 0, poll_ms: POLL_MS, result: cRes,
    }, env);
    await waitReady(consumer, 'sqlite-consumer');

    const emitter = spawnScript('sqlite-emitter.mjs', {
      run, count, pace_ms: PACE_MS, notify: mode === 'push' ? 1 : 0, result: eRes,
    }, env);

    await waitExit(emitter, 'sqlite-emitter');
    await waitExit(consumer, 'sqlite-consumer');

    const c = readJson(cRes);
    const e = readJson(eRes);
    return { consumer: c, emitter: e, throughput_eps: throughput(c, e) };
  } finally {
    if (daemon) { daemon.kill('SIGTERM'); await waitExit(daemon, 'sqlite-daemon', 5000).catch(() => daemon.kill('SIGKILL')); }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ── PG runs ─────────────────────────────────────────────────────────────────

async function pgReset() {
  const bus = createPgBus({ connectionString: CONN, poolSize: 1 });
  await bus.init();
  await bus.reset();
  await bus.close();
}

async function pgTwoProcess(variant, run) {
  await pgReset();
  const dir = mkdtempSync(join(tmpdir(), 'wb-pg-bench-'));
  const cRes = join(dir, 'consumer.json');
  const eRes = join(dir, 'emitter.json');
  const count = run === 'lat' ? LAT_COUNT : THR_COUNT;

  try {
    const consumer = spawnScript('pg-consumer.mjs', {
      variant, expect: count, warmup: run === 'lat' ? WARMUP : 0, poll_ms: POLL_MS, result: cRes,
    });
    await waitReady(consumer, 'pg-consumer');

    const emitter = spawnScript('pg-emitter.mjs', {
      variant, run, count, pace_ms: PACE_MS, result: eRes,
    });

    await waitExit(emitter, 'pg-emitter');
    await waitExit(consumer, 'pg-consumer');

    const c = readJson(cRes);
    const e = readJson(eRes);
    return { consumer: c, emitter: e, throughput_eps: throughput(c, e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pgSingle(variant, run) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-pg-single-'));
  const res = join(dir, 'result.json');
  const count = run === 'lat' ? LAT_COUNT : THR_COUNT;
  try {
    const child = spawnScript('pg-single.mjs', {
      variant, run, count, warmup: run === 'lat' ? WARMUP : 0, pace_ms: PACE_MS, poll_ms: POLL_MS, result: res,
    });
    await waitExit(child, 'pg-single');
    return readJson(res);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Drive ───────────────────────────────────────────────────────────────────

const plan = [
  ['sqlite-poll (2 proc)',          () => sqliteRun('poll', 'lat'),        () => sqliteRun('poll', 'thr')],
  ['sqlite-push (daemon, 3 proc)',  () => sqliteRun('push', 'lat'),        () => sqliteRun('push', 'thr')],
  ['pg-skip-locked-poll (1 proc)',  () => pgSingle('poll', 'lat'),         () => pgSingle('poll', 'thr')],
  ['pg-skip-locked-poll (2 proc)',  () => pgTwoProcess('poll', 'lat'),     () => pgTwoProcess('poll', 'thr')],
  ['pg-listen-notify (1 proc)',     () => pgSingle('notify', 'lat'),       () => pgSingle('notify', 'thr')],
  ['pg-listen-notify (2 proc)',     () => pgTwoProcess('notify', 'lat'),   () => pgTwoProcess('notify', 'thr')],
];

for (const [name, latFn, thrFn] of plan) {
  process.stderr.write(`\n=== ${name} — latency run ===\n`);
  const lat = await latFn();
  process.stderr.write(`=== ${name} — throughput run ===\n`);
  const thr = await thrFn();
  results[name] = { lat, thr };
  const l = lat.consumer ?? lat;
  process.stderr.write(`    p50=${l.latency_ms.p50}ms p95=${l.latency_ms.p95}ms thr=${thr.throughput_eps}/s\n`);
}

writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2));

// Print table
const rows = [['variant', 'p50 (ms)', 'p95 (ms)', 'sustained thr (ev/s)', 'complete']];
for (const [name, r] of Object.entries(results)) {
  const l = r.lat.consumer ?? r.lat;
  const t = r.thr.consumer ?? r.thr;
  rows.push([
    name,
    String(l.latency_ms.p50),
    String(l.latency_ms.p95),
    String(r.thr.throughput_eps),
    (l.incomplete || t.incomplete) ? 'INCOMPLETE' : 'yes',
  ]);
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) {
  console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '));
}
