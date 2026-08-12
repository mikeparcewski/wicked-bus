# PostgresBus go/no-go measurement

**Deliverable 3, foundation phase.** Minimal Postgres-backed bus prototype benchmarked
against the current SQLite wicked-bus on the same machine. This is a *measurement*,
not a productionization — the prototype (`src/pg-bus.js`) implements only the physics
that matter: append-only events table, durable per-subscriber cursor, transactional
SKIP LOCKED batch claim, and a LISTEN/NOTIFY wake-up hybrid.

## Environment

| | |
|---|---|
| Machine | Apple M4 Pro, 48 GB RAM, macOS (Darwin 25.5.0) |
| Node | v26.0.0 |
| Postgres | 16.14 (Debian, aarch64) in Docker, container `wicked-pg-t88`, reached via localhost port-forward `localhost:55432` |
| Raw PG round-trip on this rig | `SELECT 1` p50 **1.00 ms**, p95 1.58 ms (Docker's port-forward proxy dominates; native Linux + unix socket would be ~10–20× lower) |
| wicked-bus | `origin/main` @ `a21215f` (v2.3.1), fresh `npm ci`, throwaway `WICKED_BUS_DATA_DIR` per run (never the real bus data) |

## Methodology

- **Clock**: emitters embed `performance.timeOrigin + performance.now()` (epoch ms,
  float, sub-ms precision) in each payload; latency = consumer receive time − embedded
  time. Unlike `process.hrtime.bigint()` this is comparable *across* processes on one
  host; cross-process readings carry a small (≪1 ms) timeOrigin quantization risk.
  Single-process runs are exact monotonic deltas.
- **Latency runs**: 2,200 events paced at ~2 ms nominal (observed ~330–470 ev/s), first
  200 excluded as warm-up → **n = 2,000 measured** per variant.
- **Throughput runs**: 5,000 events back-to-back; sustained throughput = events
  received / (last-receive − first-emit), i.e. concurrent emit+consume end-to-end.
  All runs delivered 5,000/5,000 (no loss, no shortfall).
- **Poll interval**: 25 ms when idle for both poll variants (vs. the bus's 250 ms
  push-or-poll fallback default); both drain continuously while batches are non-empty.
  Asymmetry worth knowing: SQLite's poll is sub-ms, so at the paced rate it sleeps
  between events and shows the classic uniform 0–25 ms distribution (p50 ≈ 13 ms).
  The PG consume transaction is ~4 network round trips (~3–4 ms via Docker), so at the
  same rate the consumer loop never goes idle — PG-poll latency reflects transaction
  cost, not the interval.
- **Delivery semantics kept honest**: PG `consumeBatch` runs
  `BEGIN → SELECT cursor FOR UPDATE → SELECT events > cursor LIMIT k FOR UPDATE SKIP
  LOCKED → process → UPDATE cursor → COMMIT` — processing inside the transaction,
  cursor advanced transactionally, crash before COMMIT re-delivers (at-least-once).
  LISTEN/NOTIFY is only a wake-up: `pg_notify` fires atomically with the emit commit
  and triggers the *same* durable cursor read (1 s fallback poll guards missed
  notifications). SQLite poll path: `poll()` → process → `ack(batch max)`. SQLite push
  path: daemon + `subscribePushOrPoll` (per-event ack before yield — the v2 spine's
  documented at-most-once semantics).
- **PG emitter is sequential** (one awaited INSERT per event, single connection). This
  is deliberate: the prototype's max-id cursor advance is only order-safe with
  in-order commits (see caveat 1 below), so PG throughput here is a *single-producer,
  round-trip-bound* number, not a ceiling. Emit rate ≈ end-to-end rate in every PG
  run, i.e. the consumer always kept up.
- SQLite push emitter yields a `setImmediate` hop between emits so the fire-and-forget
  daemon notifies actually get event-loop time (a tight sync loop would starve them).
- Orchestrated by `bench/run-all.mjs`; raw per-run data in `bench/results.json`.

## Results

Latency is emit→consume per event (n=2,000 after warm-up); throughput is sustained
end-to-end over 5,000 events.

| variant | p50 (ms) | p95 (ms) | throughput (ev/s) |
|---|---|---|---|
| sqlite-poll (2 proc, 25 ms idle interval) | 13.26 | 25.50 | 1,879 |
| **sqlite-push (daemon, 3 proc) — THE BAR** | **1.28** | **2.52** | 1,323 |
| pg-skip-locked-poll (single process) | 4.52 | 7.49 | 617 |
| pg-skip-locked-poll (two processes) | 4.44 | 7.58 | 641 |
| pg-listen-notify (single process) | 3.87 | 6.90 | 675 |
| pg-listen-notify (two processes) | 3.43 | 7.40 | 625 |

Supplementary observations:

- **p99/max**: sqlite-push p99 13.5 ms; PG variants p99 11.5–15.2 ms, max 42–64 ms
  (Docker proxy jitter). sqlite-poll p99 26.5 ms (interval-bound).
- **PG consume-side ceiling**: drain-only (5,000 pre-inserted events, batch = 100)
  runs at **~12,500 ev/s** — the ~620–675 ev/s end-to-end numbers are purely
  emitter-round-trip-bound, not a delivery-spine limit.
- **SQLite throughput variance**: sqlite-poll end-to-end measured 1,879 ev/s in this
  run and 3,565 ev/s in an earlier identical run — WAL writer/reader contention makes
  this number noisy; treat it as "low thousands under concurrent consume", not a
  constant. sqlite-push throughput (1,323 ev/s) is bounded by the one-shot
  socket-per-emit notify design (`lib/daemon-notify.js` documents ~0.1–0.3 ms/emit).

## The bar

The reference for the delivery spine is the **current bus's daemon push path:
p50 1.28 ms / p95 2.52 ms** (measured here, same machine, same harness — no
documented latency numbers exist in the repo docs; this is the first measured
baseline). Any cross-host candidate is judged against that, minus what physics
says a network hop must cost.

## Verdict: **GO** — recommendation: **ADAPT (LISTEN/NOTIFY hybrid)**

PostgresBus is viable as the *cross-host* delivery spine, in the LISTEN/NOTIFY hybrid
form, and should not replace the local SQLite bus. The hybrid lands at p50 ~3.4–3.9 ms
/ p95 ~7 ms on this rig — about 3× the local unix-socket push bar, but ~1 ms of every
round trip is Docker's localhost proxy (4 round trips per consume transaction), so a
native deployment plausibly halves it, and low-single-digit-millisecond delivery is
far below both the 250 ms poll-fallback default and any agent-workflow latency need.
Delivery stayed honest at-least-once (durable cursor advanced transactionally,
5,000/5,000 received in every run), consume-side capacity (~12.5k ev/s drained) is an
order of magnitude above the single-producer emit rate, and the pure-poll variant is
strictly worse than the hybrid (same transaction cost, plus idle-interval latency once
traffic pauses) — so adopt NOTIFY-as-wake-up + SKIP-LOCKED-cursor-read as the shape,
not bare polling. "Adapt" rather than "adopt" because the prototype is not the
product: (1) the max-id cursor advance has a gap hazard under concurrent emitters —
a lower id committing after a higher one is skipped forever — needing txid/snapshot
fencing or claim-marker rows; (2) the 5-round-trip consume transaction should collapse
into 1–2 (single-statement CTE claim), which directly cuts p50; (3) emit-side
throughput needs batching/pipelining before any multi-producer claim is made. None of
these change the go/no-go physics measured here. The local single-host spine remains
SQLite + daemon push (still 3× faster, zero infra); PostgresBus is the opt-in remote
transport — consistent with the ecosystem's "embedded SQLite by default, Postgres
optional" decision.

## Caveats

1. **Docker-PG-on-localhost environment**: all PG numbers include ~1 ms/round-trip of
   Docker port-forward proxy tax; real cross-host adds genuine network RTT instead.
   The *relative* pg-vs-pg comparisons are clean; the pg-vs-sqlite gap is inflated.
2. **Cursor gap hazard** (prototype, documented in `src/pg-bus.js`): not exercised in
   the bench (single sequential emitter); must be fixed before concurrent producers.
3. **Cross-process clock**: two-process latencies rely on a shared system clock via
   `performance.timeOrigin`; sub-ms offset possible. Single-process PG runs (exact
   monotonic clock) agree with two-process runs within ~0.5 ms, bounding the error.
4. **Daemon push was measurable** — no fallback to documented numbers was needed. The
   push consumer ran in genuine push mode (verified at connect; run fails otherwise).
5. Single subscriber throughout; fan-out behavior (N subscribers) not measured.
