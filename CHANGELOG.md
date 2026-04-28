# Changelog

## v2.0.0 — 2026-04-28

**The local-first nervous system for AI agent meshes.**

v2.0 repositions wicked-bus from "small local message bus" to a layered local-first
coordination fabric, with every layer optional and removable. The v1 API contract
is preserved unchanged — every v1 caller continues to work.

### Highlights

- **Tiered storage.** Live SQLite + monthly warm buckets at
  `archive/bus-YYYY-MM[suffix].db` with auto-split at 10 GB.
- **Cross-tier resolution invariant.** Sweep is `INSERT-warm → COMMIT → DELETE-live`.
  The new `pollResolve()` warm-spill resolver dedupes by `event_id` (live copy
  wins) so subscribers transparently see events across the boundary with no
  silent gaps and no spurious `WB-003`.
- **Sweep with backpressure.** 5K-row batches, `PRAGMA wal_checkpoint(PASSIVE)`
  with one-shot RESTART escalation per batch, advisory bucket-lock coordination.
- **Optional push delivery daemon.** Unix-socket / named-pipe IPC with
  inline-payload threshold, per-subscriber bounded send queue, oldest-first drop
  policy, sustained-high-watermark `degrade` frame, spawn-lock thundering-herd
  protection. `subscribePushOrPoll()` composes probe + connect + transparent
  poll fall-back with catch-up drain on entering push mode.
- **Operator binaries.** `wicked-bus daemon start [--detached] | stop | status`
  and `wicked-bus ui [--detached] [--host] [--port] [--rotate-token]`.
- **Content-addressable store.** `bus.cas.put / get / exists / stats / gc` with
  offline-bucket-safe GC (aborts with `WB-010` on unreadable warm bucket;
  `--allow-missing-buckets` opt-in for operator-acknowledged absences).
- **Schema registry.** `.wicked-events/<event_type>.json` with three modes:
  `warn` (default), `cas-auto` (offload oversize payloads to CAS, rewrite to
  `{"$cas":"<sha>"}`), `strict` (throw `WB-008`). Embedded JSON Schema
  validator subset (type, required, properties, additionalProperties:false,
  enum, length/range, items).
- **Causality.** `withContext({ correlation_id, session_id, parent_event_id,
  producer_id }, fn)` over `AsyncLocalStorage` with cross-process env-var
  propagation (`WICKED_BUS_*`). Successive emits chain via `parent_event_id`.
- **Read-only embedded UI.** `127.0.0.1` default, `O_CREAT|O_EXCL` mode-0600
  bearer-token auth, Origin-restricted, GET/HEAD only. Endpoints: `/healthz`,
  `/api/info`, `/api/events`, `/api/trace/:correlation_id`, `/api/cas/stats`,
  `/api/buckets`.

### New error codes

`WB-007 LARGE_SCAN_REJECTED`, `WB-008 PAYLOAD_TOO_LARGE`, `WB-009 SCHEMA_MISMATCH`,
`WB-010 CAS_GC_INCOMPLETE_BUCKET_SET`, `WB-011 UI_TOKEN_PERMISSION_MISMATCH`,
`WB-012 LIVE_TIER_BLOAT_WARNING`, `WB-013 SPILL_BUCKET_UNAVAILABLE`.
v1 codes (`WB-001` through `WB-006`) unchanged.

### Schema migration

Additive only — `schema_migrations` row 3 lands seven nullable columns on
`events` (`parent_event_id`, `session_id`, `correlation_id`, `producer_id`,
`origin_node_id`, `registry_schema_version`, `payload_cas_sha`), two on
`cursors` (`push_socket_addr`, `lag_estimate`), and the new `schemas` table.
v1 binaries continue to read/write existing rows; new columns are invisible
to them.

### Behavioral changes

- `lib/db.js` no longer calls `process.exit(1)` on schema-version mismatch.
  Throws `WB-005 SCHEMA_VERSION_UNSUPPORTED` instead. CLI handler converts to
  JSON+exit; library callers can now catch it.

### Library footprint

`uuid` (runtime) + `better-sqlite3` (peer). No new required dependencies.
The optional daemon, UI, and CAS layers are zero-dep.

### Tests

378 tests across 50 files. Includes the §14.1 fault-injection matrix
(empty-live, cross-tier boundary, crash-window dedup, cursor in warm,
WB-003 trigger, multi-bucket order, concurrent poll+sweep, locked-bucket
WB-013, ATTACH ceiling) and §14.3 CLI-level integration tests (cas-auto
offload through `wicked-bus emit`, cross-process causality propagation
through `child_process.spawn`).

### Design history

Three rounds of multi-model council review (round 1 5-0 fix-or-reject,
round 2 6-0 CONDITIONAL, round 3 3-1 CONDITIONAL/1 APPROVE) produced the
ratified design at `DESIGN-v2.md`. Round 4 was an implementation-vs-design
audit that surfaced and fixed one defect (`process.exit` in library code).

### Deferred

`v2.1` — federation (s3/ssh/git transports), cold-tier parquet export,
reactive triggers. `v2.2` — sagas, mesh contracts, static `contracts check`.

---

## v1.1.1 — prior

See git history for v1.x release notes.
