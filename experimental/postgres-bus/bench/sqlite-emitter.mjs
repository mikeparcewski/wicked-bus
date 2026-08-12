/**
 * SQLite-bus emitter process. MEASUREMENT SPIKE ONLY.
 *
 * argv: run=lat|thr count=N pace_ms=F notify=0|1 result=/path.json
 * Requires WICKED_BUS_DATA_DIR to point at a THROWAWAY dir (set by run-all).
 *
 * run=lat  — paced emits (pace_ms between events) so batches stay small and
 *            we measure per-event delivery latency, not queue drain.
 * run=thr  — back-to-back emits. With notify=1 a setImmediate hop is awaited
 *            between emits so the fire-and-forget daemon notifies actually
 *            get event-loop time (a tight sync loop would starve them and
 *            deliver every notify after the loop — meaningless numbers).
 */

import { openDb } from '../../../lib/db.js';
import { loadConfig } from '../../../lib/config.js';
import { emit } from '../../../lib/emit.js';
import { epochNow, sleep, args, writeResult } from './common.mjs';

const a = args({ run: 'lat', count: '2200', pace_ms: '2.5', notify: '0', result: '' });
const count = Number(a.count);
const paceMs = Number(a.pace_ms);
const notify = a.notify === '1';

if (!process.env.WICKED_BUS_DATA_DIR) {
  console.error('FATAL: WICKED_BUS_DATA_DIR not set — refusing to touch the real bus dir');
  process.exit(2);
}

const config = { ...loadConfig({}), daemon_notify: notify };
const db = openDb(config);

const setImmediateP = () => new Promise((r) => setImmediate(r));

const firstEmitT = epochNow();
for (let seq = 0; seq < count; seq++) {
  emit(db, config, {
    event_type: 'wicked.bench.event.emitted',
    domain: 'bench',
    payload: { seq, t: epochNow() },
  });
  if (a.run === 'lat') {
    await sleep(paceMs);
  } else if (notify) {
    await setImmediateP(); // let the fire-and-forget notify hop run
  }
}
const lastEmitT = epochNow();

// Give pending setImmediate notifies a moment to flush before exit.
if (notify) await sleep(500);

const out = {
  role: 'emitter',
  run: a.run,
  emitted: count,
  first_emit_t: firstEmitT,
  last_emit_t: lastEmitT,
  emit_rate_eps: Math.round((count / ((lastEmitT - firstEmitT) / 1000)) * 10) / 10,
};
if (a.result) writeResult(a.result, out);
console.log(JSON.stringify(out));
db.close();
