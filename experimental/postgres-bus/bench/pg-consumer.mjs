/**
 * PostgresBus consumer process. MEASUREMENT SPIKE ONLY.
 *
 * argv: variant=poll|notify expect=N warmup=W poll_ms=25 result=/path.json
 *
 * variant=poll   — SKIP LOCKED cursor batches; continuous drain while
 *                  non-empty, sleeps poll_ms when empty (stated interval).
 * variant=notify — LISTEN/NOTIFY hybrid: NOTIFY wakes a coalesced drain of
 *                  the SAME SKIP LOCKED cursor read; a 1000 ms fallback poll
 *                  guards against missed notifications. Delivery remains
 *                  table-backed at-least-once; NOTIFY is only the wake-up.
 *
 * Prints READY once the cursor exists (and LISTEN is active) so the
 * orchestrator can start the emitter.
 */

import { createPgBus } from '../src/pg-bus.js';
import { CONN, sleep, args, writeResult, makeCollector } from './common.mjs';

const a = args({ variant: 'poll', expect: '2200', warmup: '200', poll_ms: '25', result: '', idle_timeout_ms: '15000', subscriber: 'bench-consumer' });
const expect = Number(a.expect);
const warmup = Number(a.warmup);
const pollMs = Number(a.poll_ms);
const idleTimeoutMs = Number(a.idle_timeout_ms);

const bus = createPgBus({ connectionString: CONN, poolSize: 4 });
await bus.init();
await bus.ensureCursor(a.subscriber, 0);

const collector = makeCollector(warmup);
let received = 0;
let lastProgressAt = Date.now();

async function handler(rows) {
  for (const row of rows) {
    collector.record(row.payload.seq, row.payload.t);
    received += 1;
  }
  lastProgressAt = Date.now();
}

async function finalize(incomplete, listener) {
  if (listener) await listener.close();
  const out = {
    role: 'consumer',
    variant: a.variant,
    expected: expect,
    incomplete: !!incomplete,
    ...collector.stats(),
  };
  if (a.result) writeResult(a.result, out);
  console.log(JSON.stringify(out));
  await bus.close();
  process.exit(incomplete ? 3 : 0);
}

if (a.variant === 'poll') {
  console.log('READY');
  while (received < expect) {
    const n = await bus.consumeBatch(a.subscriber, 100, handler);
    if (n === 0) {
      if (Date.now() - lastProgressAt > idleTimeoutMs) await finalize(true);
      await sleep(pollMs);
    }
  }
  await finalize(false);
} else {
  // LISTEN/NOTIFY hybrid — coalesced drain on wake.
  let draining = false;
  let dirty = false;
  let done = false;
  let resolveDone;
  const donePromise = new Promise((r) => { resolveDone = r; });

  async function drain() {
    if (draining) { dirty = true; return; }
    draining = true;
    try {
      do {
        dirty = false;
        let n;
        do {
          n = await bus.consumeBatch(a.subscriber, 100, handler);
        } while (n > 0);
      } while (dirty);
    } finally {
      draining = false;
    }
    if (!done && received >= expect) {
      done = true;
      resolveDone();
    }
  }

  const listener = await bus.listen(() => { drain().catch(() => {}); });
  console.log('READY');

  // Fallback poll for missed notifications + idle watchdog.
  const fallback = setInterval(() => {
    if (Date.now() - lastProgressAt > idleTimeoutMs) {
      done = true;
      resolveDone('timeout');
    } else {
      drain().catch(() => {});
    }
  }, 1000);

  const why = await donePromise;
  clearInterval(fallback);
  await finalize(why === 'timeout', listener);
}
