/**
 * SQLite-bus consumer process. MEASUREMENT SPIKE ONLY.
 *
 * argv: mode=poll|push expect=N warmup=W poll_ms=25 result=/path.json
 * Requires WICKED_BUS_DATA_DIR (throwaway dir, set by run-all).
 *
 * mode=poll — v1 cursor consumption: poll(batch) → record → ack(batch max).
 *             Polls continuously while batches are non-empty; sleeps poll_ms
 *             when empty (mirrors subscribe-push-or-poll's poll fallback,
 *             but at the stated tight interval instead of the 250 ms default).
 * mode=push — subscribePushOrPoll against the daemon socket (per-event ack
 *             before yield, the v2 push spine).
 *
 * Prints READY on stdout once the cursor is registered (and, for push, the
 * daemon connection established) so the orchestrator can start the emitter.
 * Inactivity timeout finalizes with a shortfall flag instead of hanging.
 */

import { openDb } from '../../../lib/db.js';
import { loadConfig } from '../../../lib/config.js';
import { register } from '../../../lib/register.js';
import { poll, ack } from '../../../lib/poll.js';
import { subscribePushOrPoll } from '../../../lib/subscribe-push-or-poll.js';
import { resolveDataDir } from '../../../lib/paths.js';
import { epochNow, sleep, args, writeResult, makeCollector } from './common.mjs';

const a = args({ mode: 'poll', expect: '2200', warmup: '200', poll_ms: '25', result: '', idle_timeout_ms: '15000' });
const expect = Number(a.expect);
const warmup = Number(a.warmup);
const pollMs = Number(a.poll_ms);
const idleTimeoutMs = Number(a.idle_timeout_ms);

if (!process.env.WICKED_BUS_DATA_DIR) {
  console.error('FATAL: WICKED_BUS_DATA_DIR not set — refusing to touch the real bus dir');
  process.exit(2);
}

const config = { ...loadConfig({}), daemon_notify: false };
const db = openDb(config);

const { cursor_id } = register(db, {
  plugin: 'bench-consumer',
  role: 'subscriber',
  filter: 'wicked.bench.event.emitted',
  cursor_init: 'oldest',
});

const collector = makeCollector(warmup);
let received = 0;
let lastProgressAt = Date.now();

function recordRow(row) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  collector.record(payload.seq, payload.t);
  received += 1;
  lastProgressAt = Date.now();
}

function finalize(incomplete) {
  const out = {
    role: 'consumer',
    mode: a.mode,
    expected: expect,
    incomplete: !!incomplete,
    ...collector.stats(),
  };
  if (a.result) writeResult(a.result, out);
  console.log(JSON.stringify(out));
  process.exit(incomplete ? 3 : 0);
}

if (a.mode === 'poll') {
  console.log('READY');
  while (received < expect) {
    const batch = poll(db, cursor_id, { batchSize: 100 });
    for (const row of batch) recordRow(row);
    if (batch.length > 0) {
      ack(db, cursor_id, batch[batch.length - 1].event_id);
    } else {
      if (Date.now() - lastProgressAt > idleTimeoutMs) finalize(true);
      await sleep(pollMs);
    }
  }
  finalize(false);
} else {
  // push mode via daemon
  const dataDir = resolveDataDir();
  const sub = await subscribePushOrPoll({
    db,
    cursor_id,
    dataDir,
    poll_interval_ms: pollMs,
  });
  if (sub.mode !== 'push') {
    console.error(`FATAL: expected push mode, got ${sub.mode} (daemon not reachable?)`);
    process.exit(2);
  }
  console.log('READY');

  const idleWatch = setInterval(() => {
    if (Date.now() - lastProgressAt > idleTimeoutMs) {
      clearInterval(idleWatch);
      sub.close();
      finalize(true);
    }
  }, 1000);
  idleWatch.unref();

  for await (const ev of sub) {
    recordRow(ev);
    if (received >= expect) break;
  }
  clearInterval(idleWatch);
  sub.close();
  finalize(received < expect);
}
