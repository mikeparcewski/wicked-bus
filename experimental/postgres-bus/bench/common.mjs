/**
 * Shared bench utilities. MEASUREMENT SPIKE ONLY.
 *
 * Clock: epochNow() = performance.timeOrigin + performance.now() — an epoch
 * timestamp in ms (float, sub-ms precision). Unlike process.hrtime.bigint()
 * it is comparable ACROSS processes on the same machine (both anchor to the
 * same system clock). Cross-process readings carry a small timeOrigin
 * quantization/offset risk (well under 1 ms on one host); single-process
 * runs are exact monotonic deltas. Stated in the report's methodology.
 */

import { writeFileSync } from 'node:fs';

export const CONN = process.env.PG_URL || 'postgres://wicked:wicked@localhost:55432/bus_bench';

export function epochNow() {
  return performance.timeOrigin + performance.now();
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

export function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    min: round(sorted[0] ?? null),
    max: round(sorted[sorted.length - 1] ?? null),
    mean: round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
  };
}

function round(v) {
  return v == null ? null : Math.round(v * 1000) / 1000;
}

export function writeResult(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse `key=value` argv pairs into an object. */
export function args(defaults = {}) {
  const out = { ...defaults };
  for (const a of process.argv.slice(2)) {
    const i = a.indexOf('=');
    if (i > 0) out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

/**
 * Latency collector with warm-up exclusion by sequence number.
 * Events carry payload { seq, t } — t is the emitter's epochNow() at emit.
 */
export function makeCollector(warmup) {
  const latencies = [];
  let received = 0;
  let firstRecvT = null;
  let lastRecvT = null;
  return {
    record(seq, emitT) {
      const now = epochNow();
      received += 1;
      if (firstRecvT === null) firstRecvT = now;
      lastRecvT = now;
      if (seq >= warmup) latencies.push(now - emitT);
    },
    stats() {
      return {
        received,
        first_recv_t: firstRecvT,
        last_recv_t: lastRecvT,
        latency_ms: summarize(latencies),
      };
    },
  };
}
