/**
 * Integration smoke for the crew sidecars.
 *
 * Proves, against a throwaway temp DB:
 *   1. reducer handles `wicked.run.requested` exactly ONCE even when the event
 *      is re-delivered (at-least-once) before it is acked.
 *   2. skill-provisioner turns `wicked.skill.needed` into a correlated
 *      `wicked.skill.ready`, and does NOT consume its own `.ready`.
 *   3. the reducer's cursor is durable: a fresh instance resumes from the
 *      persisted cursor and picks up a new event without re-registering.
 *
 * Run:  node examples/crew-sidecars/smoke.js
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate everything (bus DB + sidecar state) in a throwaway dir BEFORE the
// sidecar modules resolve the data dir / open the DB.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-smoke-'));
process.env.WICKED_BUS_DATA_DIR = DATA_DIR;

const { loadConfig, openDb, emit, register, poll } = await import('../../lib/index.js');
const { makeReducer } = await import('./reducer-sidecar.js');
const { makeProvisioner } = await import('./skill-provisioner-sidecar.js');

let failures = 0;
function assert(cond, msg) {
  const ok = !!cond;
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}\n`);
  if (!ok) failures++;
}
function section(t) { process.stdout.write(`\n=== ${t} ===\n`); }

process.stdout.write(`data dir: ${DATA_DIR}\n`);

// Shared emitter connection (a producer would own one of these).
const config = loadConfig();
const busDb = openDb(config);

const RUN_ID = 'run-abc123';

// A downstream verifier that consumes the provisioner's output.
const verifier = register(busDb, {
  plugin: 'smoke-verifier',
  role: 'subscriber',
  filter: 'wicked.skill.ready',
  cursor_init: 'oldest',
});

// ── build the sidecars (register their durable subscriptions) ───────────────
const reducer = makeReducer();
const provisioner = makeProvisioner();
reducer.ensureRegistered();
provisioner.ensureRegistered();

// ── emit the two driving events ─────────────────────────────────────────────
section('emit driving events');
const reqEmit = emit(busDb, config, {
  event_type: 'wicked.run.requested',
  domain: 'wicked-crew',
  subdomain: 'orchestrator',
  correlation_id: RUN_ID,
  payload: {
    run_id: RUN_ID,
    workflow: 'ship-feature',
    problem: 'add CSV export',
    args: { branch: 'feat/csv' },
  },
});
process.stdout.write(`  emitted wicked.run.requested event_id=${reqEmit.event_id}\n`);

const needEmit = emit(busDb, config, {
  event_type: 'wicked.skill.needed',
  domain: 'wicked-crew',
  subdomain: 'orchestrator',
  correlation_id: RUN_ID,
  payload: { run_id: RUN_ID, skill: 'csv-export' },
});
process.stdout.write(`  emitted wicked.skill.needed event_id=${needEmit.event_id}\n`);

// ── 1. reducer idempotency across a simulated re-delivery ───────────────────
section('reducer: idempotent handling across re-delivery');
// First pass: handle but DO NOT ack (simulates a crash right after handling).
const t1 = reducer.tick({ ack: false });
process.stdout.write(`  tick#1 (no ack): ${JSON.stringify(t1)}\n`);
// Second pass: same event is re-delivered (still > cursor). Must be skipped.
const t2 = reducer.tick({ ack: false });
process.stdout.write(`  tick#2 (re-delivery): ${JSON.stringify(t2)}\n`);
// Third pass: normal ack to advance the cursor.
const t3 = reducer.tick({ ack: true });
process.stdout.write(`  tick#3 (ack): ${JSON.stringify(t3)}\n`);

assert(t1.handled === 1, 'first delivery handled the run once');
assert(t2.handled === 0 && t2.skipped === 1, 're-delivery skipped (not re-handled)');
assert(reducer.state.records.length === 1, 'exactly ONE run record persisted despite re-delivery');
assert(reducer.state.records[0].run_id === RUN_ID, `run record carries run_id ${RUN_ID}`);

// ── 2. provisioner produces a correlated ready ──────────────────────────────
section('skill-provisioner: correlated .ready');
const p1 = provisioner.tick({ ack: true });
process.stdout.write(`  provisioner tick#1: ${JSON.stringify(p1)}\n`);
assert(p1.handled === 1, 'provisioner handled the skill.needed once');

// Provisioner must NOT consume its own .ready (exact filter). Tick again → 0.
const p2 = provisioner.tick({ ack: true });
process.stdout.write(`  provisioner tick#2: ${JSON.stringify(p2)}\n`);
assert(p2.handled === 0 && p2.polled === 0, 'provisioner did NOT consume its own .ready');

// Downstream verifier sees exactly one correlated ready.
const readies = poll(busDb, verifier.cursor_id, { batchSize: 50 });
process.stdout.write(`  verifier polled ${readies.length} wicked.skill.ready event(s)\n`);
assert(readies.length === 1, 'exactly one wicked.skill.ready emitted');
if (readies.length === 1) {
  const r = readies[0];
  const payload = JSON.parse(r.payload);
  process.stdout.write(`  ready: correlation_id=${r.correlation_id} payload=${r.payload}\n`);
  assert(r.event_type === 'wicked.skill.ready', 'ready event_type correct');
  assert(r.correlation_id === RUN_ID, `ready correlation_id == ${RUN_ID}`);
  assert(payload.run_id === RUN_ID, `ready payload.run_id == ${RUN_ID}`);
  assert(payload.skill === 'csv-export', 'ready carries the requested skill');
  assert(payload.installed === true, 'ready marks skill installed');
}

// ── 3. durable cursor across a simulated restart ────────────────────────────
section('reducer: durable cursor resumes across restart');
const reqEmit2 = emit(busDb, config, {
  event_type: 'wicked.run.requested',
  domain: 'wicked-crew',
  subdomain: 'orchestrator',
  correlation_id: 'run-def456',
  payload: { run_id: 'run-def456', workflow: 'fix-bug', problem: 'npe on null cart' },
});
process.stdout.write(`  emitted 2nd wicked.run.requested event_id=${reqEmit2.event_id}\n`);

reducer.close(); // drop the first instance's DB handle (simulate process exit)

const reducer2 = makeReducer(); // fresh instance, same state file
const reg = reducer2.ensureRegistered();
process.stdout.write(`  restart resumed=${reg.resumed} cursor=${reducer2.state.cursor_id}\n`);
assert(reg.resumed === true, 'fresh instance RESUMED (did not re-register)');
assert(
  reducer2.state.cursor_id === reducer.state.cursor_id,
  'resumed cursor_id matches the persisted one'
);

const t4 = reducer2.tick({ ack: true });
process.stdout.write(`  post-restart tick: ${JSON.stringify(t4)}\n`);
assert(t4.handled === 1, 'resumed reducer handled ONLY the new run (old run already acked)');
assert(
  reducer2.state.records.some((r) => r.run_id === 'run-def456'),
  'new run recorded after restart'
);
assert(reducer2.state.records.length === 2, 'total of two runs recorded across the restart');

// ── result ──────────────────────────────────────────────────────────────────
section('result');
reducer2.close();
provisioner.close();
busDb.close();
process.stdout.write(failures === 0 ? '\nALL ASSERTIONS PASSED\n' : `\n${failures} ASSERTION(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
