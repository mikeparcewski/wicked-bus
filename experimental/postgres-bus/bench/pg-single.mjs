/**
 * PostgresBus single-process bench: emitter + consumer in ONE Node process
 * (shared pool, separate connections). MEASUREMENT SPIKE ONLY.
 *
 * argv: variant=poll|notify run=lat|thr count=N warmup=W pace_ms=F poll_ms=25 result=/path.json
 */

import { createPgBus } from '../src/pg-bus.js';
import { CONN, epochNow, sleep, args, writeResult, makeCollector } from './common.mjs';

const a = args({ variant: 'poll', run: 'lat', count: '2200', warmup: '200', pace_ms: '2.5', poll_ms: '25', result: '' });
const count = Number(a.count);
const warmup = Number(a.warmup);
const paceMs = Number(a.pace_ms);
const pollMs = Number(a.poll_ms);
const notify = a.variant === 'notify';
const SUBSCRIBER = 'bench-single';

const bus = createPgBus({ connectionString: CONN, poolSize: 6 });
await bus.init();
await bus.reset();
await bus.ensureCursor(SUBSCRIBER, 0);

const collector = makeCollector(warmup);
let received = 0;

async function handler(rows) {
  for (const row of rows) {
    collector.record(row.payload.seq, row.payload.t);
    received += 1;
  }
}

// ── Emitter side ────────────────────────────────────────────────────────────
let firstEmitT = null;
let lastEmitT = null;
async function emitAll() {
  firstEmitT = epochNow();
  for (let seq = 0; seq < count; seq++) {
    await bus.emit('wicked.bench.event.emitted', { seq, t: epochNow() }, { notify });
    if (a.run === 'lat') await sleep(paceMs);
  }
  lastEmitT = epochNow();
}

// ── Consumer side ───────────────────────────────────────────────────────────
async function consumePoll() {
  while (received < count) {
    const n = await bus.consumeBatch(SUBSCRIBER, 100, handler);
    if (n === 0) await sleep(pollMs);
  }
}

async function consumeNotify() {
  let draining = false;
  let dirty = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  async function drain() {
    if (draining) { dirty = true; return; }
    draining = true;
    try {
      do {
        dirty = false;
        let n;
        do {
          n = await bus.consumeBatch(SUBSCRIBER, 100, handler);
        } while (n > 0);
      } while (dirty);
    } finally {
      draining = false;
    }
    if (received >= count) resolveDone();
  }

  const listener = await bus.listen(() => { drain().catch(() => {}); });
  const fallback = setInterval(() => { drain().catch(() => {}); }, 1000);
  await done;
  clearInterval(fallback);
  await listener.close();
}

const consumer = notify ? consumeNotify() : consumePoll();
await sleep(50); // let LISTEN settle before first emit
await Promise.all([emitAll(), consumer]);

const stats = collector.stats();
const out = {
  variant: a.variant,
  run: a.run,
  topology: 'single-process',
  emitted: count,
  first_emit_t: firstEmitT,
  last_emit_t: lastEmitT,
  emit_rate_eps: Math.round((count / ((lastEmitT - firstEmitT) / 1000)) * 10) / 10,
  throughput_eps: Math.round((count / ((stats.last_recv_t - firstEmitT) / 1000)) * 10) / 10,
  ...stats,
};
if (a.result) writeResult(a.result, out);
console.log(JSON.stringify(out));
await bus.close();
