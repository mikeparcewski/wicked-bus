/**
 * PostgresBus emitter process. MEASUREMENT SPIKE ONLY.
 *
 * argv: variant=poll|notify run=lat|thr count=N pace_ms=F result=/path.json
 *
 * run=lat — paced emits. run=thr — sequential back-to-back awaited INSERTs
 * (single connection, one round-trip per event). Sequential on purpose: the
 * prototype's max-id cursor advance is only order-safe with in-order commits
 * (see src/pg-bus.js caveat), so throughput here is single-producer,
 * round-trip-bound — stated in the report.
 */

import { createPgBus } from '../src/pg-bus.js';
import { CONN, epochNow, sleep, args, writeResult } from './common.mjs';

const a = args({ variant: 'poll', run: 'lat', count: '2200', pace_ms: '2.5', result: '' });
const count = Number(a.count);
const paceMs = Number(a.pace_ms);
const notify = a.variant === 'notify';

const bus = createPgBus({ connectionString: CONN, poolSize: 4 });
await bus.init();

const firstEmitT = epochNow();
for (let seq = 0; seq < count; seq++) {
  await bus.emit('wicked.bench.event.emitted', { seq, t: epochNow() }, { notify });
  if (a.run === 'lat') await sleep(paceMs);
}
const lastEmitT = epochNow();

const out = {
  role: 'emitter',
  variant: a.variant,
  run: a.run,
  emitted: count,
  first_emit_t: firstEmitT,
  last_emit_t: lastEmitT,
  emit_rate_eps: Math.round((count / ((lastEmitT - firstEmitT) / 1000)) * 10) / 10,
};
if (a.result) writeResult(a.result, out);
console.log(JSON.stringify(out));
await bus.close();
