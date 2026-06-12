import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');

/**
 * Real multi-process contention. The existing concurrent.test.js opens two DB
 * handles in ONE process, which does not exercise OS-level cross-process
 * locking — the whole premise of a SQLite-backed bus shared by independent
 * tools (brain, testing, interactive). This test forks REAL child processes
 * (child_process.fork) that hammer the same temp DB simultaneously, then
 * asserts on the parent that:
 *   1. Zero events are lost (every uniquely-keyed emit landed exactly once).
 *   2. Zero duplicates exist (the idempotency_key UNIQUE constraint holds under
 *      real concurrent writers — overlapping keys collapse to one row).
 *   3. Concurrent consumers (cursor-based poll/ack) never lose or double-count.
 *
 * Cross-platform: uses fork() (Node child, no shell), node:path for all paths,
 * and a generated .mjs worker. No bash-only constructs.
 */
describe('multi-process contention (real subprocesses)', () => {
  let tmpDir, originalEnv, workerPath;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-mp-contention-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);

    // Bootstrap the schema once from the parent so child writers race only on
    // INSERTs, not on concurrent DDL.
    const bootDb = openDb(loadConfig());
    bootDb.close();

    workerPath = join(tmpDir, 'emit-worker.mjs');
    // Worker: open the bus from WICKED_BUS_DATA_DIR and emit a deterministic
    // set of events. Half the keys are PRIVATE (unique per worker) and half
    // are SHARED (identical across all workers) so the UNIQUE idempotency
    // constraint is forced to dedupe under genuine cross-process contention.
    const lib = LIB_DIR.replace(/\\/g, '/'); // file:// URLs use forward slashes
    writeFileSync(workerPath, `
import { pathToFileURL } from 'node:url';
const { openDb }     = await import(pathToFileURL(${JSON.stringify(lib + '/db.js')}).href);
const { loadConfig } = await import(pathToFileURL(${JSON.stringify(lib + '/config.js')}).href);
const { emit }       = await import(pathToFileURL(${JSON.stringify(lib + '/emit.js')}).href);

const workerId  = process.env.WB_WORKER_ID;
const perWorker = Number(process.env.WB_PER_WORKER);
const sharedN   = Number(process.env.WB_SHARED);

const config = loadConfig();
// daemon_notify disabled: no daemon in this test; avoids the setImmediate hop.
config.daemon_notify = false;
const db = openDb(config);

let dupErrors = 0;
let ok = 0;

// Private events: unique per worker — must all land.
for (let i = 0; i < perWorker; i++) {
  try {
    emit(db, config, {
      event_type: 'wicked.mp.emitted',
      domain: 'wb-mp-test',
      idempotency_key: 'priv-' + workerId + '-' + i,
      payload: { worker: workerId, i },
    });
    ok++;
  } catch (e) {
    process.send && process.send({ fatal: String(e && e.message) });
  }
}

// Shared events: identical keys across ALL workers — exactly one INSERT per
// key may win; the rest must raise WB-002 (DUPLICATE_EVENT).
for (let i = 0; i < sharedN; i++) {
  try {
    emit(db, config, {
      event_type: 'wicked.mp.shared',
      domain: 'wb-mp-test',
      idempotency_key: 'shared-' + i,
      payload: { i },
    });
    ok++;
  } catch (e) {
    if (e && e.error === 'WB-002') dupErrors++;
    else process.send && process.send({ fatal: String(e && e.message) });
  }
}

db.close();
process.send && process.send({ done: true, workerId, ok, dupErrors });
process.exit(0);
`);
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.WICKED_BUS_DATA_DIR = originalEnv;
    } else {
      delete process.env.WICKED_BUS_DATA_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  function runWorker(workerId, perWorker, shared) {
    return new Promise((resolve, reject) => {
      const child = fork(workerPath, [], {
        env: {
          ...process.env,
          WICKED_BUS_DATA_DIR: tmpDir,
          WB_WORKER_ID: String(workerId),
          WB_PER_WORKER: String(perWorker),
          WB_SHARED: String(shared),
        },
        // Inherit stdio for diagnostics but keep IPC channel open.
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      let result = null;
      child.on('message', (msg) => {
        if (msg && msg.fatal) reject(new Error('worker ' + workerId + ' fatal: ' + msg.fatal));
        else if (msg && msg.done) result = msg;
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error('worker ' + workerId + ' exited ' + code));
        else resolve(result);
      });
    });
  }

  it('zero lost events and zero duplicates under N concurrent OS processes', async () => {
    const WORKERS = 4;
    const PER_WORKER = 50;   // private, unique per worker
    const SHARED = 20;       // shared keys contended across all workers

    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_, w) => runWorker(w, PER_WORKER, SHARED))
    );

    // Every worker reported back.
    expect(results.filter(Boolean)).toHaveLength(WORKERS);

    const db = openDb(loadConfig());

    // ── Zero lost events: every private key landed exactly once ─────────────
    const privCount = db.prepare(
      "SELECT COUNT(*) c FROM events WHERE event_type = 'wicked.mp.emitted'"
    ).get().c;
    expect(privCount).toBe(WORKERS * PER_WORKER);

    // ── Zero duplicates: each shared key collapsed to exactly one row ───────
    const sharedRows = db.prepare(
      "SELECT idempotency_key, COUNT(*) c FROM events WHERE event_type = 'wicked.mp.shared' GROUP BY idempotency_key"
    ).all();
    expect(sharedRows).toHaveLength(SHARED);
    for (const row of sharedRows) {
      expect(row.c).toBe(1); // UNIQUE constraint held under real concurrency
    }

    // No idempotency_key appears more than once across the WHOLE table.
    const dupKeys = db.prepare(
      'SELECT idempotency_key, COUNT(*) c FROM events GROUP BY idempotency_key HAVING c > 1'
    ).all();
    expect(dupKeys).toHaveLength(0);

    // Cross-check the workers' own accounting: total successful shared INSERTs
    // equals SHARED (one winner per key); the rest were WB-002 duplicates.
    const totalSharedOk = results.reduce((s, r) => s + (r.ok - PER_WORKER), 0);
    const totalDupErrors = results.reduce((s, r) => s + r.dupErrors, 0);
    expect(totalSharedOk).toBe(SHARED);
    expect(totalDupErrors).toBe(WORKERS * SHARED - SHARED);

    db.close();
  }, 30000);

  it('concurrent consumers (poll/ack across processes) never lose or double-count', async () => {
    // First, seed a known backlog with one writer process.
    const SEED = 120;
    await runWorker('seed', SEED, 0); // SEED private 'wicked.mp.emitted' events

    const db = openDb(loadConfig());
    const total = db.prepare(
      "SELECT COUNT(*) c FROM events WHERE event_type = 'wicked.mp.emitted'"
    ).get().c;
    expect(total).toBe(SEED);
    db.close();

    // Generate a consumer worker that drains via its OWN cursor and reports
    // which event_ids it saw. Two consumers with INDEPENDENT cursors must EACH
    // see every event exactly once (fan-out: cursors are per-subscriber).
    const lib = LIB_DIR.replace(/\\/g, '/');
    const consumerPath = join(tmpDir, 'consume-worker.mjs');
    writeFileSync(consumerPath, `
import { pathToFileURL } from 'node:url';
const { openDb }     = await import(pathToFileURL(${JSON.stringify(lib + '/db.js')}).href);
const { loadConfig } = await import(pathToFileURL(${JSON.stringify(lib + '/config.js')}).href);
const { register }   = await import(pathToFileURL(${JSON.stringify(lib + '/register.js')}).href);
const { poll, ack }  = await import(pathToFileURL(${JSON.stringify(lib + '/poll.js')}).href);

const config = loadConfig();
config.daemon_notify = false;
const db = openDb(config);

const reg = register(db, {
  plugin: 'consumer-' + process.env.WB_CONSUMER_ID,
  role: 'subscriber',
  filter: 'wicked.mp.**',
  cursor_init: 'oldest',
});

const seen = [];
for (;;) {
  const batch = poll(db, reg.cursor_id, { batchSize: 7 });
  if (batch.length === 0) break;
  for (const ev of batch) seen.push(ev.event_id);
  ack(db, reg.cursor_id, batch[batch.length - 1].event_id);
}
db.close();
process.send && process.send({ done: true, seen });
process.exit(0);
`);

    function runConsumer(id) {
      return new Promise((resolve, reject) => {
        const child = fork(consumerPath, [], {
          env: { ...process.env, WICKED_BUS_DATA_DIR: tmpDir, WB_CONSUMER_ID: String(id) },
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        let result = null;
        child.on('message', (m) => { if (m && m.done) result = m; });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve(result) : reject(new Error('consumer exit ' + code)));
      });
    }

    const [c0, c1] = await Promise.all([runConsumer(0), runConsumer(1)]);

    for (const c of [c0, c1]) {
      // Exactly SEED events, no duplicates within a single consumer's cursor.
      expect(c.seen).toHaveLength(SEED);
      expect(new Set(c.seen).size).toBe(SEED);
    }
  }, 30000);
});
