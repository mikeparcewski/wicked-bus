# wicked-bus Specification v1.0.0

A lightweight, local-first event bridge for the wicked-\* ecosystem. SQLite-backed, single-host,
poll-based delivery. No network transport in v1.

**Package**: `wicked-bus`  
**Node.js**: >= 18.0.0 (ESM primary)  
**Storage**: SQLite via `better-sqlite3`  
**Spec date**: 2026-04-11

---

## Table of Contents

1. [Overview](#1-overview)
2. [Quick Start](#2-quick-start)
3. [Package Layout](#3-package-layout)
4. [DomainStore Schema (Full DDL)](#4-domainstore-schema-full-ddl)
5. [Event Schema](#5-event-schema)
6. [Registration Contracts](#6-registration-contracts)
7. [Delivery Semantics](#7-delivery-semantics)
8. [CLI Reference](#8-cli-reference)
9. [Integration Patterns](#9-integration-patterns)
10. [Failure Modes and Error Codes](#10-failure-modes-and-error-codes)
11. [Configuration Reference](#11-configuration-reference)
12. [Cross-Platform Support](#12-cross-platform-support)
13. [Versioning and Migration](#13-versioning-and-migration)
14. [Known v1 Constraints](#14-known-v1-constraints)

---

## 1. Overview

`wicked-bus` is a local event bridge that lets wicked-\* plugins publish and subscribe to domain
events without any network transport. Events are stored in an SQLite database (`bus.db`) using WAL
mode, and delivered to subscribers via an explicit cursor-poll model.

**Design principles**:
- **Local-first**: all data lives in `~/.something-wicked/wicked-bus/bus.db`; no sockets, no HTTP
- **At-least-once delivery**: cursors persist across restarts; unacked events are re-delivered
- **Graceful degradation**: callers that cannot reach the bus log a debug message and continue
- **Fire-and-forget integration**: all integration hooks are non-blocking; the bus never slows the caller
- **Single-host only** (v1): multi-machine fan-out is deferred to v2

**Supported wicked-\* integrations** (v1):
| Plugin | Integration Type | Timeout |
|--------|-----------------|---------|
| wicked-testing | Node.js dynamic import + `Promise.race` | 50 ms |
| wicked-garden | Python subprocess via `wicked-bus` CLI | 100 ms |
| wicked-brain | Python subprocess via `wicked-bus` CLI | 100 ms |

---

## 2. Quick Start

### Installation

```bash
npm install wicked-bus
```

`better-sqlite3` compiles a native addon; it must be installed in the same environment as wicked-bus.

### Initialize the data directory

```bash
wicked-bus init
# → {"initialized": true, "data_dir": "/Users/alice/.something-wicked/wicked-bus", "db_path": "...bus.db"}
```

### Emit your first event

```bash
wicked-bus emit \
  --type wicked.test.run.completed \
  --source wicked-testing \
  --payload '{"runId":"run-abc","status":"passed","duration_ms":840}'
# → {"event_id": 1, "idempotency_key": "550e8400-..."}
```

### Register a subscriber and poll

```bash
# Register
wicked-bus register \
  --role subscriber \
  --plugin my-consumer \
  --filter 'wicked.test.run.*' \
  --cursor-init latest
# → {"subscription_id": "...", "cursor_id": "...", "last_event_id": 1}

# Poll (NDJSON stream, Ctrl-C to exit)
wicked-bus subscribe \
  --plugin my-consumer \
  --filter 'wicked.test.run.*'
```

### Check status

```bash
wicked-bus status
```

---

## 3. Package Layout

### npm Package Identity

```json
{
  "name": "wicked-bus",
  "version": "1.0.0",
  "description": "Lightweight local-first event bridge for the wicked-* ecosystem",
  "type": "module",
  "engines": { "node": ">=18.0.0" },
  "license": "MIT"
}
```

### Exports Map

```json
{
  "main": "./lib/index.js",
  "exports": {
    ".": {
      "import": "./lib/index.js",
      "require": "./lib/index.cjs"
    },
    "./cli": "./commands/cli.js"
  },
  "bin": {
    "wicked-bus": "./commands/cli.js"
  }
}
```

The CJS wrapper (`lib/index.cjs`) is a thin re-export shim for tooling that cannot consume ESM.
It must not be the primary API surface.

### Dependencies

```json
{
  "peerDependencies": {
    "better-sqlite3": ">=9.0.0"
  },
  "peerDependenciesMeta": {
    "better-sqlite3": { "optional": false }
  },
  "dependencies": {
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "vitest": "^1.0.0"
  }
}
```

`better-sqlite3` is a required peer (not bundled) because it compiles a native addon at install
time. The plugin cannot pre-bundle it without locking to a specific Node.js ABI.

### Directory Structure

```
wicked-bus/
├── package.json
├── .claude-plugin/
│   └── plugin.json              # Claude Code plugin registration
├── lib/
│   ├── index.js                 # Public API: emit, subscribe, register, poll, ack
│   ├── index.cjs                # CJS shim
│   ├── db.js                    # SQLite connection manager + schema bootstrap
│   ├── schema.sql               # DDL for all tables (full source of truth)
│   ├── emit.js                  # Event emit logic + validation
│   ├── poll.js                  # Subscriber poll logic + cursor advancement
│   ├── sweep.js                 # TTL / deduplication sweep worker
│   ├── paths.js                 # Cross-platform data directory resolution
│   ├── config.js                # config.json read/write helpers
│   ├── errors.js                # Typed error classes (WB-001 through WB-006)
│   └── validate.js              # Event schema validation
├── commands/
│   ├── cli.js                   # Main CLI entry (shebang: #!/usr/bin/env node)
│   ├── cmd-init.js
│   ├── cmd-emit.js
│   ├── cmd-subscribe.js
│   ├── cmd-status.js
│   ├── cmd-replay.js
│   ├── cmd-cleanup.js
│   ├── cmd-register.js
│   ├── cmd-deregister.js
│   ├── cmd-list.js
│   └── cmd-ack.js
└── scripts/
    └── postinstall.js           # Auto-init: creates data dir on npm install
```

### CLI Binary

The `commands/cli.js` shebang must be `#!/usr/bin/env node` and the file must have execute
permission. npm's bin wrapper handles Windows resolution via `node` automatically.

---

## 4. DomainStore Schema (Full DDL)

**File**: `lib/schema.sql`

All `CREATE TABLE` statements use `IF NOT EXISTS` — the schema is idempotent and safe to re-apply.

### Initialization Sequence

`lib/db.js` runs these PRAGMAs in order before executing `schema.sql`:

1. `PRAGMA journal_mode = WAL;`
2. `PRAGMA synchronous = NORMAL;`
3. `PRAGMA foreign_keys = ON;`
4. `PRAGMA busy_timeout = 5000;`

| PRAGMA | Value | Reason |
|--------|-------|--------|
| `journal_mode` | `WAL` | Concurrent readers do not block writers; required for multi-process access |
| `synchronous` | `NORMAL` | fsync on WAL checkpoint only; safe against OS crash; balances durability with throughput |
| `foreign_keys` | `ON` | Enforce cursor → subscription referential integrity at DB level |
| `busy_timeout` | `5000` | Retry DB locks for up to 5 seconds before surfacing `SQLITE_BUSY` |

### Full DDL

```sql
-- ============================================================
-- wicked-bus v1 schema
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ── events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type        TEXT    NOT NULL CHECK(length(event_type) <= 128),
    source_plugin     TEXT    NOT NULL CHECK(length(source_plugin) <= 64),
    payload           TEXT    NOT NULL,                 -- JSON text
    schema_version    TEXT    NOT NULL DEFAULT '1.0.0',
    idempotency_key   TEXT    NOT NULL UNIQUE,          -- UUID; DB-enforced uniqueness
    emitted_at        INTEGER NOT NULL,                 -- Unix epoch ms
    expires_at        INTEGER NOT NULL,                 -- emitted_at + ttl_ms  (visibility filter)
    dedup_expires_at  INTEGER NOT NULL,                 -- emitted_at + dedup_ttl_ms (row deletion trigger)
    metadata          TEXT                              -- JSON text, nullable
);

CREATE INDEX IF NOT EXISTS idx_events_event_type       ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_emitted_at       ON events(emitted_at);
CREATE INDEX IF NOT EXISTS idx_events_expires_at       ON events(expires_at);
CREATE INDEX IF NOT EXISTS idx_events_dedup_expires_at ON events(dedup_expires_at);
-- idempotency_key already covered by its UNIQUE constraint index

-- ── subscriptions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id          TEXT    PRIMARY KEY,           -- UUID
    plugin                   TEXT    NOT NULL,
    role                     TEXT    NOT NULL
                               CHECK(role IN ('provider','subscriber')),
    event_type_filter        TEXT    NOT NULL,              -- exact or wildcard pattern
    schema_version           TEXT,                          -- declared by provider; NULL for subscribers
    registered_at            INTEGER NOT NULL,              -- Unix epoch ms
    deregistered_at          INTEGER,                       -- NULL = active
    health_check_interval_ms INTEGER DEFAULT 60000
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plugin ON subscriptions(plugin);
-- Partial index: active subscriptions only (SQLite supports WHERE clause in indexes)
CREATE INDEX IF NOT EXISTS idx_subscriptions_active
    ON subscriptions(plugin, role)
    WHERE deregistered_at IS NULL;

-- ── cursors ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cursors (
    cursor_id         TEXT    PRIMARY KEY,                 -- UUID
    subscription_id   TEXT    NOT NULL
                        REFERENCES subscriptions(subscription_id)
                        ON DELETE RESTRICT,
    last_event_id     INTEGER NOT NULL DEFAULT 0,          -- 0 = before first event
    acked_at          INTEGER,                             -- Unix epoch ms; NULL until first ack
    created_at        INTEGER NOT NULL,                    -- Unix epoch ms
    deregistered_at   INTEGER                              -- NULL = active; set by wicked-bus deregister
);

CREATE INDEX IF NOT EXISTS idx_cursors_subscription_id ON cursors(subscription_id);
CREATE INDEX IF NOT EXISTS idx_cursors_active
    ON cursors(subscription_id)
    WHERE deregistered_at IS NULL;

-- ── schema_migrations ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,                          -- Unix epoch ms
    description TEXT
);

-- Seed version 1 if not already present
INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
VALUES (1, unixepoch() * 1000, 'initial schema');
```

### Column Summary by Table

**`events`** (AC-19)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `event_id` | INTEGER | PK AUTOINCREMENT | Assigned by DB; never supplied by producer |
| `event_type` | TEXT | NOT NULL, max 128 chars | Dot-separated namespace |
| `source_plugin` | TEXT | NOT NULL, max 64 chars | e.g. `"wicked-testing"` |
| `payload` | TEXT | NOT NULL | JSON text; max `max_payload_bytes` (default 1 MB) |
| `schema_version` | TEXT | NOT NULL DEFAULT `'1.0.0'` | Semver; declared by producer |
| `idempotency_key` | TEXT | NOT NULL UNIQUE | UUID v4; auto-generated if not supplied |
| `emitted_at` | INTEGER | NOT NULL | Unix epoch ms; set by wicked-bus on write |
| `expires_at` | INTEGER | NOT NULL | `emitted_at + ttl_ms`; visibility filter for polls |
| `dedup_expires_at` | INTEGER | NOT NULL | `emitted_at + dedup_ttl_ms`; row deletion trigger |
| `metadata` | TEXT | nullable | JSON text; arbitrary producer-supplied context |

**`subscriptions`** (AC-20)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `subscription_id` | TEXT | PK | UUID |
| `plugin` | TEXT | NOT NULL | Plugin name |
| `role` | TEXT | NOT NULL CHECK | `'provider'` or `'subscriber'` |
| `event_type_filter` | TEXT | NOT NULL | Exact match or wildcard pattern |
| `schema_version` | TEXT | nullable | Declared by provider; NULL for subscribers |
| `registered_at` | INTEGER | NOT NULL | Unix epoch ms |
| `deregistered_at` | INTEGER | nullable | NULL = active; set on soft-delete |
| `health_check_interval_ms` | INTEGER | DEFAULT 60000 | Reserved for v2 health-check polling |

**`cursors`** (AC-21)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `cursor_id` | TEXT | PK | UUID |
| `subscription_id` | TEXT | NOT NULL FK | References `subscriptions(subscription_id)` ON DELETE RESTRICT |
| `last_event_id` | INTEGER | NOT NULL DEFAULT 0 | 0 = before first event |
| `acked_at` | INTEGER | nullable | Unix epoch ms; NULL until first ack |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |
| `deregistered_at` | INTEGER | nullable | NULL = active; soft-delete marker |

**IMPORTANT — `cursors.deregistered_at`**: this column is REQUIRED (AC-31). `wicked-bus deregister`
soft-deletes cursor rows by setting `deregistered_at` to the current timestamp, NOT by hard-deleting
them. Events already in the log remain intact.

---

## 5. Event Schema

### Envelope Fields

| Field | Type | Required | Constraints | Notes |
|-------|------|----------|-------------|-------|
| `event_id` | integer | Auto | AUTOINCREMENT PK | Never supplied by producer |
| `event_type` | string | Yes | max 128 chars; pattern: `wicked.<domain>.<noun>.<verb>` | See naming convention |
| `source_plugin` | string | Yes | max 64 chars | e.g. `"wicked-testing"` |
| `payload` | object | Yes | Valid JSON; max `max_payload_bytes` (1 MB) | Serialized as TEXT in DB |
| `schema_version` | string | No | semver; default `"1.0.0"` | Declared by producer |
| `idempotency_key` | string | No | UUID v4; auto-generated if omitted | UNIQUE DB constraint |
| `emitted_at` | integer | Auto | Unix epoch ms | Set by wicked-bus on write |
| `expires_at` | integer | Auto | `emitted_at + ttl_ms` | Visibility filter for polls |
| `dedup_expires_at` | integer | Auto | `emitted_at + dedup_ttl_ms` | Row deletion trigger |
| `metadata` | object | No | Nullable JSON | Arbitrary producer-supplied context |

### Naming Convention

```
wicked.<domain>.<noun>.<past-tense-verb>
```

- All lowercase, dot-separated
- `<domain>`: plugin short name (`test`, `crew`, `brain`)
- `<noun>`: entity that changed (`run`, `phase`, `memory`)
- `<past-tense-verb>`: what happened (`completed`, `started`, `stored`)

All v1 catalog event types use **four segments**. Three-segment names (e.g. `wicked.test.completed`)
are not used in v1 and should not be constructed dynamically.

### Validation Rules (WB-001 triggers)

- `event_type`: required; string; max 128 chars; must match `/^wicked\.[a-z0-9_]+(\.[a-z0-9_]+)*$/`
- `source_plugin`: required; string; max 64 chars
- `payload`: required; must be a valid JSON-serializable object
- `schema_version`: if present, must match semver `/^\d+\.\d+\.\d+$/`
- Payload size: `JSON.stringify(payload).length <= config.max_payload_bytes`

### Event Catalog (v1)

#### wicked-testing Events

| Event Type | Trigger | Key Payload Fields |
|-----------|---------|-------------------|
| `wicked.test.run.started` | Test run begins | `runId`, `projectId`, `scenarioId`, `startedAt` |
| `wicked.test.run.completed` | Test run finishes | `runId`, `projectId`, `scenarioId`, `status`, `duration_ms`, `evidencePath` |
| `wicked.test.run.failed` | Test run errors out | `runId`, `projectId`, `error`, `duration_ms` |
| `wicked.test.verdict.created` | Verdict recorded | `verdictId`, `runId`, `verdict`, `reviewer` |
| `wicked.test.scenario.created` | New scenario created | `scenarioId`, `projectId`, `name`, `format_version` |
| `wicked.test.project.created` | New project created | `projectId`, `name` |

#### wicked-garden Events

| Event Type | Trigger | Key Payload Fields |
|-----------|---------|-------------------|
| `wicked.crew.phase.started` | Phase begins | `projectId`, `phaseName`, `startedAt` |
| `wicked.crew.phase.completed` | Phase completes | `projectId`, `phaseName`, `duration_ms`, `deliverables` |
| `wicked.crew.phase.skipped` | Phase skipped | `projectId`, `phaseName`, `reason` |
| `wicked.crew.phase.failed` | Phase fails gate | `projectId`, `phaseName`, `gateErrors` |
| `wicked.crew.project.created` | New crew project | `projectId`, `name`, `description` |
| `wicked.crew.project.archived` | Project archived | `projectId`, `archivedAt` |

#### wicked-brain Events

| Event Type | Trigger | Key Payload Fields |
|-----------|---------|-------------------|
| `wicked.brain.memory.stored` | Memory chunk written | `chunkId`, `tier`, `tags`, `size_bytes` |
| `wicked.brain.memory.updated` | Memory chunk updated | `chunkId`, `tier`, `tags` |
| `wicked.brain.knowledge.updated` | Knowledge index rebuilt | `indexSize`, `chunkCount`, `duration_ms` |
| `wicked.brain.memory.expired` | Memory chunk expired | `chunkId`, `tier` |

### Example Wire Format

```json
{
  "event_id": 42,
  "event_type": "wicked.test.run.completed",
  "source_plugin": "wicked-testing",
  "payload": {
    "runId": "run-abc123",
    "projectId": "proj-xyz",
    "scenarioId": "scen-456",
    "status": "passed",
    "duration_ms": 1840,
    "evidencePath": ".wicked-testing/runs/run-abc123"
  },
  "schema_version": "1.0.0",
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
  "emitted_at": 1744393800000,
  "expires_at": 1744652600000,
  "dedup_expires_at": 1744480200000,
  "metadata": {
    "hostname": "dev-machine",
    "node_version": "v20.11.0"
  }
}
```

---

## 6. Registration Contracts

### Provider Registration

A plugin registers as a provider to declare which event types it will emit.

**CLI**:
```bash
wicked-bus register \
  --role provider \
  --plugin wicked-testing \
  --events "wicked.test.run.started,wicked.test.run.completed,wicked.test.run.failed" \
  --schema-version 1.0.0
```

**Response (stdout)**:
```json
{
  "subscription_id": "a1b2c3d4-...",
  "plugin": "wicked-testing",
  "role": "provider",
  "registered_at": 1744393800000
}
```

**Side effect**: a JSON sidecar is written to `~/.something-wicked/wicked-bus/providers/<plugin-name>.json`.
This file is informational only (human-readable inspection). The authoritative record is the
`subscriptions` table row.

**Provider sidecar format**:
```json
{
  "subscription_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "plugin": "wicked-testing",
  "role": "provider",
  "event_types": [
    "wicked.test.run.started",
    "wicked.test.run.completed",
    "wicked.test.run.failed"
  ],
  "schema_version": "1.0.0",
  "registered_at": "2026-04-11T18:30:00.000Z",
  "registered_at_ms": 1744393800000
}
```

### Subscriber Registration

A plugin registers as a subscriber to receive events matching a filter.

**CLI**:
```bash
wicked-bus register \
  --role subscriber \
  --plugin my-consumer \
  --filter "wicked.test.run.*" \
  --cursor-init latest
```

**Response (stdout)**:
```json
{
  "subscription_id": "b2c3d4e5-...",
  "cursor_id": "c3d4e5f6-...",
  "plugin": "my-consumer",
  "role": "subscriber",
  "filter": "wicked.test.run.*",
  "cursor_init": "latest",
  "last_event_id": 99,
  "registered_at": 1744393800000
}
```

### Cursor Initialization Modes

| Mode | Behavior | `last_event_id` initial value |
|------|----------|-------------------------------|
| `oldest` | Receive all non-expired events from the beginning of the log | `0` |
| `latest` | Receive only events emitted after registration | `MAX(event_id)` from `events`, or `0` if empty |

### Filter Semantics (v1)

Filters are evaluated against `event_type` at poll time:

```javascript
function matchesFilter(eventType, filter) {
  if (filter === eventType) return true;                    // exact match
  if (filter.endsWith('.*')) {
    const prefix = filter.slice(0, -2);                    // strip .*
    if (eventType.startsWith(prefix + '.')) {
      const remainder = eventType.slice(prefix.length + 1);
      return !remainder.includes('.');                      // single-level only
    }
  }
  return false;
}
```

| Filter | Matches | Does Not Match |
|--------|---------|---------------|
| `wicked.test.run.completed` | `wicked.test.run.completed` only | `wicked.test.run.started` |
| `wicked.test.run.*` | `wicked.test.run.completed`, `wicked.test.run.started`, `wicked.test.run.failed` | `wicked.test.verdict.created` |
| `wicked.crew.phase.*` | `wicked.crew.phase.completed`, `wicked.crew.phase.started` | `wicked.crew.project.completed` |

**IMPORTANT**: `wicked.test.*` does **NOT** match `wicked.test.run.completed` because the wildcard
is single-level only and all v1 catalog events are four-segment. Use `wicked.test.run.*` to match
all run events. Multi-level wildcards (`wicked.**`) are deferred to v2.

### Deregistration

```bash
wicked-bus deregister --subscription-id <uuid>
```

**Behavior**:
1. Sets `subscriptions.deregistered_at = now()` for the given `subscription_id`
2. For subscribers: soft-deletes associated cursor rows (sets `cursors.deregistered_at`, NOT hard-delete)
3. Removes the provider JSON sidecar from `providers/` directory (if provider role)
4. Events already in the log are unaffected and can be re-consumed if the plugin re-registers

**Response**:
```json
{"deregistered": true, "subscription_id": "...", "deregistered_at": 1744393800000}
```

---

## 7. Delivery Semantics

### At-Least-Once Delivery

wicked-bus guarantees at-least-once delivery per subscriber via the cursor mechanism:

1. Subscriber calls poll (CLI or API)
2. wicked-bus queries:
   ```sql
   SELECT * FROM events
   WHERE event_id > :last_event_id
     AND expires_at > :now
     AND <filter matches event_type>
   ORDER BY event_id ASC
   LIMIT :batch_size
   ```
3. Events are delivered to the subscriber (NDJSON to stdout or returned from API)
4. Subscriber processes events and calls `wicked-bus ack --cursor-id X --last-event-id N`
5. wicked-bus atomically updates:
   ```sql
   UPDATE cursors SET last_event_id = N, acked_at = :now WHERE cursor_id = X
   ```
6. Next poll starts from `last_event_id = N + 1`

**Cursor advancement is explicit** — the subscriber must ack. wicked-bus never auto-advances.

### Poll Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `poll_interval_ms` | 1000 ms | Frequency of poll loop in CLI subscribe mode |
| `batch_size` | 100 | Maximum events returned per poll call |

### Retry on Crash

When a subscriber crashes before acking:

1. The `cursors` row retains `last_event_id` at the last successfully acked value
2. On restart, subscriber polls from `last_event_id + 1`
3. Events delivered but not acked are re-delivered (at-least-once guarantee holds)
4. Subscriber **must** use `idempotency_key` to detect and discard re-delivered events

### Subscriber-Side Idempotency Pattern

```javascript
const processed = new Set(); // or LRU cache with TTL = dedup_ttl_hours

for (const event of deliveredEvents) {
  if (processed.has(event.idempotency_key)) continue; // duplicate, discard
  await handleEvent(event);
  processed.add(event.idempotency_key);
  await ack(cursorId, event.event_id);
}
```

Use an LRU cache (not an unbounded Set) for long-running subscribers.

### Two-Timer TTL Semantics

Every event row carries two independent expiry timestamps:

| Column | Formula | Config Key | Default | Purpose |
|--------|---------|-----------|---------|---------|
| `expires_at` | `emitted_at + (ttl_hours * 3_600_000)` | `ttl_hours` | 72h | **Visibility filter**: events past this time are excluded from poll results |
| `dedup_expires_at` | `emitted_at + (dedup_ttl_hours * 3_600_000)` | `dedup_ttl_hours` | 24h | **Row deletion trigger**: sweep deletes rows past this time, freeing the `idempotency_key` UNIQUE slot |

**Critical**: with defaults `dedup_ttl_hours=24` and `ttl_hours=72`, rows are **deleted at T+24h**
even though they would have become invisible at T+72h. A subscriber whose cursor is older than 24h
will receive `WB-003 CURSOR_BEHIND_TTL_WINDOW` because the rows no longer exist — not because
`expires_at` was exceeded.

Config validation must enforce `dedup_ttl_hours <= ttl_hours`.

### Background TTL Sweep

`lib/sweep.js` runs on a configurable interval:

```javascript
export function startSweep(db, config) {
  const intervalMs = config.sweep_interval_minutes * 60_000;
  return setInterval(() => runSweep(db, config), intervalMs);
}

function runSweep(db, config) {
  const now = Date.now();
  const txn = db.transaction(() => {
    if (config.archive_mode) {
      db.prepare(
        'INSERT OR IGNORE INTO events_archive SELECT * FROM events WHERE dedup_expires_at < ?'
      ).run(now);
    }
    const result = db.prepare(
      'DELETE FROM events WHERE dedup_expires_at < ?'
    ).run(now);
    return result.changes;
  });
  const count = txn();
  if (count > 0) debug(`[wicked-bus sweep] purged ${count} expired event rows`);
}
```

Default sweep interval: **15 minutes**. The sweep runs in-process when the CLI `subscribe` command
is active. For library/headless usage, the embedding process must call `startSweep`. A v2 daemon
model is planned for moving this out-of-process.

### Deduplication

`idempotency_key UNIQUE` in SQLite is the primary deduplication mechanism. When a producer emits
with a key that already exists:

```javascript
try {
  const result = insertStmt.run(params);
  return { event_id: result.lastInsertRowid, idempotency_key: params.idempotency_key };
} catch (err) {
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const original = db.prepare(
      'SELECT event_id FROM events WHERE idempotency_key = ?'
    ).get(params.idempotency_key);
    throw new WBError('WB-002', 'DUPLICATE_EVENT', {
      original_event_id: original?.event_id,
      idempotency_key: params.idempotency_key,
    });
  }
  throw err;
}
```

The dedup window is controlled by `dedup_ttl_hours`. Once `dedup_expires_at < now`, the row is swept
and the key is freed — a new event with the same `idempotency_key` is accepted as a new write.

---

## 8. CLI Reference

All commands write structured JSON to stdout on success. Errors are written as JSON to stderr with a
non-zero exit code.

### Global Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--db-path <path>` | string | resolved data dir | Override database location |
| `--json` | boolean | false | Force JSON output for human-readable commands |
| `--log-level <level>` | string | `warn` | Override log level for this invocation |

---

### `wicked-bus init`

Initialize the wicked-bus data directory and SQLite database. (AC-1, AC-2)

```bash
wicked-bus init [--data-dir <path>] [--force]
```

| Flag | Description |
|------|-------------|
| `--data-dir <path>` | Override data directory (default: platform-resolved per Section 12) |
| `--force` | Re-initialize even if already initialized (non-destructive; schema migration safe) |

**Behavior**:
1. Resolve and create data directory (recursive mkdir)
2. Open SQLite at `<data-dir>/bus.db`
3. Apply `schema.sql` (idempotent)
4. Write `config.json` with defaults if not present
5. Confirm PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`

**stdout**:
```json
{"initialized": true, "data_dir": "/Users/alice/.something-wicked/wicked-bus", "db_path": "...bus.db"}
```

**Exit codes**: 0 success, 1 error

---

### `wicked-bus emit`

Emit an event to the bus. (AC-3, AC-4, AC-13)

```bash
wicked-bus emit \
  --type <event_type> \
  --source <source_plugin> \
  --payload <json_string_or_@file> \
  [--idempotency-key <uuid>] \
  [--schema-version <semver>] \
  [--ttl-hours <number>] \
  [--metadata <json_string>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--type` | Yes | Event type (e.g. `wicked.test.run.completed`) |
| `--source` | Yes | Source plugin name |
| `--payload` | Yes | JSON string or `@/path/to/file` for file input |
| `--idempotency-key` | No | UUID; auto-generated if omitted |
| `--schema-version` | No | Default `"1.0.0"` |
| `--ttl-hours` | No | Per-event TTL override; default from `config.json` |
| `--metadata` | No | JSON string for metadata field |

**stdout (success)**:
```json
{"event_id": 42, "idempotency_key": "550e8400-..."}
```

**stderr (error)**:
```json
{"error": "WB-001", "code": "INVALID_EVENT_SCHEMA", "message": "missing required field: event_type"}
```

**Exit codes**: 0 success, 1 validation error (WB-001), 2 duplicate (WB-002), 4 disk full (WB-004)

---

### `wicked-bus subscribe`

Register a subscriber and enter a polling loop streaming NDJSON to stdout. (AC-14)

```bash
wicked-bus subscribe \
  --plugin <name> \
  --filter <event_type_pattern> \
  [--cursor-init <oldest|latest>] \
  [--cursor-id <uuid>] \
  [--poll-interval-ms <ms>] \
  [--batch-size <n>] \
  [--no-ack]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--plugin` | required | Subscriber plugin name |
| `--filter` | required | Event type filter (exact or `wicked.X.Y.*` wildcard) |
| `--cursor-init` | `latest` | Cursor initialization mode for new subscriptions |
| `--cursor-id` | — | Resume existing subscription by cursor UUID; skips registration. If omitted and a subscription already exists for the `--plugin` + `--filter` pair, wicked-bus looks up and reuses the existing cursor. If no match exists, a new subscription is created using `--cursor-init`. |
| `--poll-interval-ms` | `1000` | Poll frequency in milliseconds |
| `--batch-size` | `100` | Max events per poll |
| `--no-ack` | false | Deliver without advancing cursor (observe-only mode) |

**Implicit cursor lookup rule**: When `--cursor-id` is omitted, wicked-bus queries `subscriptions` for an active row where `plugin = :plugin AND event_type_filter = :filter AND deregistered_at IS NULL`. If exactly one match is found, its associated cursor is reused. If multiple matches exist (plugin registered multiple times with same filter), wicked-bus returns an error and requires `--cursor-id` to disambiguate.

**stdout**: NDJSON — one JSON object per line per delivered event:
```
{"event_id":42,"event_type":"wicked.test.run.completed","source_plugin":"wicked-testing",...}
{"event_id":43,"event_type":"wicked.test.run.failed",...}
```

**Behavior on Ctrl-C**: graceful shutdown; cursor persisted at last acked `event_id`; exits 0.

**Exit codes**: 0 clean exit, 1 error, 3 WB-003 cursor behind TTL

---

### `wicked-bus status`

Show bus health and subscriber lag. (AC-15)

```bash
wicked-bus status [--json]
```

**stdout**:
```json
{
  "db_path": "/home/user/.something-wicked/wicked-bus/bus.db",
  "total_events": 1204,
  "oldest_event_id": 1,
  "newest_event_id": 1204,
  "events_by_type": {
    "wicked.test.run.completed": 88,
    "wicked.crew.phase.completed": 12
  },
  "subscribers": [
    {
      "subscription_id": "b2c3d4e5-...",
      "plugin": "my-consumer",
      "cursor_id": "c3d4e5f6-...",
      "last_event_id": 1198,
      "lag": 6,
      "last_acked_at": 1744393700000
    }
  ],
  "providers": [
    {
      "subscription_id": "a1b2c3d4-...",
      "plugin": "wicked-testing",
      "event_types": ["wicked.test.run.started", "wicked.test.run.completed"]
    }
  ]
}
```

**Exit codes**: 0 success, 1 DB unreachable

---

### `wicked-bus replay`

Reset a subscriber cursor to replay events from a specific event ID. (AC-16)

```bash
wicked-bus replay \
  --cursor-id <uuid> \
  --from-event-id <n>
```

**Behavior**: Sets `last_event_id = from-event-id - 1` atomically. Logs the reset with operator
timestamp to the bus debug log.

**stdout**:
```json
{"replayed": true, "cursor_id": "...", "reset_to": 99, "from_event_id": 100}
```

**Exit codes**: 0 success, 1 cursor not found, 2 event ID below oldest available

---

### `wicked-bus cleanup`

Delete expired events and orphaned cursor rows. (AC-17)

```bash
wicked-bus cleanup [--dry-run] [--archive]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Print count of rows that would be deleted without modifying data |
| `--archive` | Move expired events to `events_archive` table before deleting |

**stdout**:
```json
{"events_deleted": 412, "cursors_removed": 2, "dry_run": false}
```

**Exit codes**: 0 success, 1 error

---

### `wicked-bus register`

Register a provider or subscriber. (AC-5, AC-6)

```bash
wicked-bus register \
  --role <provider|subscriber> \
  --plugin <name> \
  [--events <event_type,...>]          # provider only
  [--schema-version <semver>]          # provider only
  [--filter <event_type_pattern>]      # subscriber only
  [--cursor-init <oldest|latest>]      # subscriber only
```

See [Registration Contracts](#6-registration-contracts) for response formats.

**Exit codes**: 0 success, 1 validation error

---

### `wicked-bus deregister`

Deregister a provider or subscriber (soft delete). (AC-31)

```bash
wicked-bus deregister --subscription-id <uuid>
```

**stdout**:
```json
{"deregistered": true, "subscription_id": "...", "deregistered_at": 1744393800000}
```

**Exit codes**: 0 success, 1 not found

---

### `wicked-bus list`

List all registered providers and/or subscribers. (AC-18)

```bash
wicked-bus list \
  [--role <provider|subscriber>] \
  [--include-deregistered] \
  [--json]
```

| Flag | Description |
|------|-------------|
| `--role` | Filter by role; omit for all |
| `--include-deregistered` | Include soft-deleted records |
| `--json` | Output as JSON array instead of table |

**stdout (`--json`)**:
```json
[
  {
    "subscription_id": "a1b2c3d4-...",
    "plugin": "wicked-testing",
    "role": "provider",
    "event_types": ["wicked.test.run.completed"],
    "schema_version": "1.0.0",
    "registered_at": 1744393800000,
    "deregistered_at": null
  }
]
```

**Exit codes**: 0 success, 1 error

---

### `wicked-bus ack`

Advance a subscriber cursor after successful processing. (AC-7)

```bash
wicked-bus ack --cursor-id <uuid> --last-event-id <n>
```

**Implementation** (`cmd-ack.js`):
```javascript
const stmt = db.prepare(
  'UPDATE cursors SET last_event_id = ?, acked_at = ? WHERE cursor_id = ?'
);
const txn = db.transaction((cursorId, lastEventId, now) => {
  const result = stmt.run(lastEventId, now, cursorId);
  if (result.changes === 0) throw new WBError('WB-006', 'CURSOR_NOT_FOUND');
});
txn(cursorId, lastEventId, Date.now());
```

**stdout**:
```json
{"acked": true, "cursor_id": "...", "last_event_id": 42}
```

**Exit codes**: 0 success, 1 cursor not found (WB-006)

---

## 9. Integration Patterns

### 9a. wicked-testing (`_emitEvent` Hook)

**Integration point**: `lib/domain-store.mjs`, inside the `DomainStore` class.

The existing `_emitEvent` method is a no-op stub reserved for this integration. Replace it with:

```javascript
// ─── Top of file, after existing imports ─────────────────────────────────────
let _wickedBusEmit = null;
let _wickedBusChecked = false;

async function _loadWickedBus() {
  if (_wickedBusChecked) return _wickedBusEmit;
  _wickedBusChecked = true;
  try {
    const mod = await import('wicked-bus');
    _wickedBusEmit = mod.emit;
  } catch (_) {
    _wickedBusEmit = null; // not installed — graceful degradation
  }
  return _wickedBusEmit;
}

// ─── Explicit event type mapping (inside DomainStore class) ──────────────────
// All catalog event types are four-segment: wicked.test.<noun>.<past-tense-verb>
// Do NOT construct event types dynamically from action strings.
const WICKED_BUS_EVENT_MAP = {
  'run.completed':      'wicked.test.run.completed',
  'run.started':        'wicked.test.run.started',
  'run.failed':         'wicked.test.run.failed',
  'verdict.created':    'wicked.test.verdict.created',
  'strategy.generated': 'wicked.test.strategy.generated',
  'scenario.authored':  'wicked.test.scenario.authored',
};

// ─── Replace the no-op _emitEvent stub ───────────────────────────────────────
_emitEvent(action, source, id, payload) {
  // Fire-and-forget: do not await; do not block the caller.
  const eventType = WICKED_BUS_EVENT_MAP[`${source}.${action}`]
    ?? `wicked.test.${source}.${action}`; // fallback for unmapped actions
  const eventPayload = { id, ...payload };

  Promise.race([
    _loadWickedBus().then(emit => {
      if (!emit) return;
      return emit({
        event_type: eventType,
        source_plugin: 'wicked-testing',
        payload: eventPayload,
      });
    }),
    new Promise(resolve => setTimeout(resolve, 50)), // 50ms hard timeout (AC-22)
  ]).catch(err => {
    if (process.env.DEBUG?.includes('wicked-bus')) {
      process.stderr.write(
        `[wicked-bus] not available, event dropped: ${eventType} — ${err.message}\n`
      );
    }
  });
  // Returns immediately — event write is async and non-blocking
}
```

**Graceful degradation** (AC-23): if `wicked-bus` is not installed or unavailable, `_loadWickedBus`
returns `null`, the `Promise.race` resolves to `undefined`, and the caller sees no error. The debug
log only fires when `DEBUG=wicked-bus` is set.

**Key properties**:
- `import('wicked-bus')` is attempted exactly once and cached (`_wickedBusChecked` flag)
- `Promise.race` with 50ms timeout: bus I/O never blocks test execution by more than 50ms
- No throw, no test failure, no change in observable test output

---

### 9b. wicked-garden (`phase_manager` Hook)

**Integration point**: `scripts/crew/phase_manager.py`, phase transition handlers.

```python
# ─── Add at top of phase_manager.py ──────────────────────────────────────────
import subprocess
import threading
import json as _json

def _emit_phase_event(event_type: str, project_id: str, phase_name: str,
                       extra: dict = None) -> None:
    """Fire-and-forget wicked-bus event. Never raises. 100ms timeout."""
    payload = {"projectId": project_id, "phaseName": phase_name}
    if extra:
        payload.update(extra)
    payload_str = _json.dumps(payload)

    def _emit():
        try:
            try:
                from wicked_bus import emit as _wb_emit
                _wb_emit(event_type=event_type, source_plugin="wicked-garden", payload=payload)
                return
            except ImportError:
                pass  # Fall through to subprocess

            subprocess.run(
                ["wicked-bus", "emit",
                 "--type", event_type,
                 "--source", "wicked-garden",
                 "--payload", payload_str],
                timeout=0.1,        # 100ms hard limit (AC-24)
                capture_output=True,
                check=False,        # Never raise on non-zero exit
            )
        except Exception as exc:
            logger.warning("[wicked-bus] emit failed, event dropped: %s — %s", event_type, exc)

    threading.Thread(target=_emit, daemon=True).start()
    # Do NOT .join() — caller returns immediately

# ─── Call sites ───────────────────────────────────────────────────────────────
def complete_phase(project_id, phase_name, duration_ms, deliverables):
    # ... existing gate logic ...
    _emit_phase_event("wicked.crew.phase.completed", project_id, phase_name,
                      extra={"duration_ms": duration_ms, "deliverables": deliverables})

def start_phase(project_id, phase_name):
    _emit_phase_event("wicked.crew.phase.started", project_id, phase_name)

def skip_phase(project_id, phase_name, reason):
    _emit_phase_event("wicked.crew.phase.skipped", project_id, phase_name,
                      extra={"reason": reason})
```

**Graceful degradation** (AC-25): daemon thread; 100ms subprocess timeout; `check=False`; all
exceptions caught and logged as `warning`. wicked-garden never fails due to bus unavailability.

---

### 9c. wicked-brain (Knowledge Events)

**Integration point**: wherever wicked-brain writes a new memory chunk or updates its knowledge
index.

```python
def _emit_brain_event(event_type: str, chunk_id: str, tier: str,
                       tags: list, extra: dict = None) -> None:
    """Fire-and-forget. Never raises. 100ms timeout."""
    import json, subprocess, threading

    payload = {"chunkId": chunk_id, "tier": tier, "tags": tags}
    if extra:
        payload.update(extra)

    def _emit():
        try:
            subprocess.run(
                ["wicked-bus", "emit",
                 "--type", event_type,
                 "--source", "wicked-brain",
                 "--payload", json.dumps(payload)],
                timeout=0.1,
                capture_output=True,
                check=False,
            )
        except Exception as exc:
            import logging
            logging.getLogger("wicked-brain").debug(
                "[wicked-bus] not available, knowledge event dropped: %s — %s",
                event_type, exc
            )

    threading.Thread(target=_emit, daemon=True).start()

# Usage
_emit_brain_event("wicked.brain.memory.stored", chunk_id, tier, tags,
                  extra={"size_bytes": len(content)})
_emit_brain_event("wicked.brain.knowledge.updated", chunk_id="", tier="index",
                  tags=[], extra={"indexSize": index_size, "chunkCount": chunk_count})
```

**Graceful degradation** (AC-30): subprocess timeout or exception results in a single `debug`-level
log. No memory storage operation is affected by bus unavailability.

---

## 10. Failure Modes and Error Codes

### Error Code Table

| Code | Name | Trigger | CLI Exit Code | Behavior |
|------|------|---------|--------------|----------|
| WB-001 | `INVALID_EVENT_SCHEMA` | Missing required field, type violation, payload too large | 1 | Reject event; no DB write; structured error to stderr |
| WB-002 | `DUPLICATE_EVENT` | `idempotency_key` already exists in `events` table | 2 | Reject; return original `event_id`; no DB write |
| WB-003 | `CURSOR_BEHIND_TTL_WINDOW` | Subscriber cursor points before oldest available row | 3 | Return warning with oldest available `event_id`; do not auto-reset |
| WB-004 | `DISK_FULL` | SQLite write fails with `SQLITE_FULL` or `ENOSPC` | 4 | Reject event; do not corrupt DB; signal error to caller |
| WB-005 | `SCHEMA_VERSION_UNSUPPORTED` | Producer declares `schema_version` with major > 1 | 5 | Reject event; log mismatch; no DB write |
| WB-006 | `CURSOR_NOT_FOUND` | `ack` call references a `cursor_id` that does not exist or is deregistered | 6 | Reject ack; return error with cursor_id in context |

### Structured Error Format

All errors use the same JSON envelope (written to stderr for CLI; thrown as typed error for API):

```json
{
  "error": "WB-001",
  "code": "INVALID_EVENT_SCHEMA",
  "message": "missing required field: event_type",
  "context": {
    "received_fields": ["source_plugin", "payload"]
  }
}
```

### WB-001: INVALID_EVENT_SCHEMA

Triggered by `lib/validate.js` before any DB interaction. Validation rules:

- `event_type`: required; string; max 128 chars; matches `/^wicked\.[a-z0-9_]+(\.[a-z0-9_]+)*$/`
- `source_plugin`: required; string; max 64 chars
- `payload`: required; must be valid JSON-serializable object
- `schema_version`: if present, must match semver `/^\d+\.\d+\.\d+$/`
- Payload size: `JSON.stringify(payload).length <= config.max_payload_bytes`

### WB-002: DUPLICATE_EVENT

Caught in `lib/emit.js` on `SQLITE_CONSTRAINT_UNIQUE`. Returns the original `event_id` so callers
can idempotently confirm the event exists without a second write.

### WB-003: CURSOR_BEHIND_TTL_WINDOW

Returned by the poll path when `cursor.last_event_id < (MIN(event_id) - 1)`. The WB-003 check uses
`MIN(event_id)` from the **actual rows in the table** (not filtered by `expires_at`), because the
deletion trigger is `dedup_expires_at`, not `expires_at`.

Subscriber must either:
- Call `wicked-bus replay --cursor-id X --from-event-id <oldest_available>` to reset forward, or
- Halt and alert operators

### WB-004: DISK_FULL

Caught when SQLite write returns `SQLITE_FULL` or Node.js raises `ENOSPC`. wicked-bus:

1. Does NOT attempt to delete old events to make space (ring-buffer deferred to v2)
2. Closes and re-opens the DB connection to verify it is not corrupted
3. Returns WB-004 to the caller
4. Logs: `[wicked-bus] DISK_FULL: cannot write event, bus.db at capacity`

Callers in graceful-degradation mode swallow this error silently.

### WB-005: SCHEMA_VERSION_UNSUPPORTED

v1 bus accepts `schema_version` in the `1.x` range. Major version 2+ is rejected:

```javascript
const [major] = schemaVersion.split('.').map(Number);
if (major > MAX_SUPPORTED_SCHEMA_MAJOR) { // MAX_SUPPORTED_SCHEMA_MAJOR = 1
  throw new WBError('WB-005', 'SCHEMA_VERSION_UNSUPPORTED', {
    declared: schemaVersion,
    max_supported: '1.x',
  });
}
```

### WB-006: CURSOR_NOT_FOUND

The `ack` call references a `cursor_id` that does not exist or has `deregistered_at` set. The
cursor is not modified; the caller must re-register to obtain a new cursor.

### DB Locked / Concurrent Access

`PRAGMA busy_timeout = 5000` causes SQLite to retry for up to 5 seconds before returning
`SQLITE_BUSY`. Concurrent writes from multiple Node.js processes are safe under WAL mode.

### Schema Mismatch on Open

If `schema_migrations` contains a version > `MAX_SUPPORTED_SCHEMA_VERSION`, the process exits
with code 1 with a message directing the user to upgrade: `npm install -g wicked-bus`. No data
is modified.

---

## 11. Configuration Reference

**File location**: `<data-dir>/config.json`

Written by `wicked-bus init` with defaults. All fields are optional; missing fields use the default.

### Default `config.json`

```json
{
  "ttl_hours": 72,
  "dedup_ttl_hours": 24,
  "sweep_interval_minutes": 15,
  "archive_mode": false,
  "log_level": "warn",
  "db_path": null,
  "max_payload_bytes": 1048576
}
```

### Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ttl_hours` | integer | `72` | Event visibility TTL in hours. Events past `expires_at` are excluded from polls. Must be >= `dedup_ttl_hours`. |
| `dedup_ttl_hours` | integer | `24` | Idempotency key uniqueness window. Rows past `dedup_expires_at` are swept, freeing the UNIQUE slot. Must be <= `ttl_hours`. |
| `sweep_interval_minutes` | integer | `15` | Background sweep frequency. Set to `0` to disable (manual `wicked-bus cleanup` only). |
| `archive_mode` | boolean | `false` | If `true`, expired rows move to `events_archive` before deletion. If `false`, hard-deleted. |
| `log_level` | string | `"warn"` | Verbosity: `"debug"`, `"info"`, `"warn"`, `"error"`. |
| `db_path` | string\|null | `null` | Absolute path override for `bus.db`. If `null`, resolved to `<data-dir>/bus.db`. |
| `max_payload_bytes` | integer | `1048576` | Maximum serialized payload size in bytes (1 MB). Events exceeding this are rejected with WB-001. |

### Config Loading (`lib/config.js`)

```javascript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from './paths.js';

const DEFAULTS = {
  ttl_hours: 72,
  dedup_ttl_hours: 24,
  sweep_interval_minutes: 15,
  archive_mode: false,
  log_level: 'warn',
  db_path: null,
  max_payload_bytes: 1_048_576,
};

export function loadConfig(dataDir = null) {
  const dir = dataDir ?? resolveDataDir();
  const configPath = join(dir, 'config.json');
  let userConfig = {};
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (_) {
      // Malformed config: ignore, use defaults
    }
  }
  const merged = { ...DEFAULTS, ...userConfig };
  // Validation
  if (merged.dedup_ttl_hours > merged.ttl_hours) {
    throw new Error('[wicked-bus] config error: dedup_ttl_hours must be <= ttl_hours');
  }
  return merged;
}
```

### Environment Override

| Variable | Effect |
|----------|--------|
| `WICKED_BUS_DATA_DIR` | Override the data directory entirely (highest priority; useful for CI) |
| `DEBUG=wicked-bus` | Enable debug-level logging for graceful degradation messages |

---

## 12. Cross-Platform Support

### Data Directory Resolution (`lib/paths.js`)

Resolution order:
1. `WICKED_BUS_DATA_DIR` environment variable (highest priority)
2. Platform-specific convention:

| Platform | Path |
|----------|------|
| macOS / Linux | `$HOME/.something-wicked/wicked-bus/` |
| Windows (APPDATA set) | `%APPDATA%\.something-wicked\wicked-bus\` |
| Windows (APPDATA unset) | `%USERPROFILE%\.something-wicked\wicked-bus\` |
| Git Bash / WSL | Uses `$HOME` → same as Linux |
| CI override | `WICKED_BUS_DATA_DIR=/tmp/test-bus` |

### Implementation

```javascript
import { platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const APP_DIR = '.something-wicked';
const BUS_DIR = 'wicked-bus';

export function resolveDataDir() {
  if (process.env.WICKED_BUS_DATA_DIR) return process.env.WICKED_BUS_DATA_DIR;

  let base;
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    const userProfile = process.env.USERPROFILE;
    const winHome = process.env.HOME; // Git Bash sets HOME
    base = appdata ?? userProfile ?? winHome ?? process.cwd();
  } else {
    const home = process.env.HOME;
    if (!home) throw new Error('[wicked-bus] $HOME is not set; cannot resolve data directory');
    base = home;
  }

  const resolved = join(base, APP_DIR, BUS_DIR);
  debug(`[wicked-bus] data directory resolved to: ${resolved}`);
  return resolved;
}

export function ensureDataDir() {
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveDbPath(config) {
  if (config?.db_path) return config.db_path;
  return join(ensureDataDir(), 'bus.db');
}
```

### CLI Binary (Cross-Platform)

- POSIX: shebang `#!/usr/bin/env node`; `chmod +x` in `postinstall.js`
- Windows: npm's bin wrapper generates a `.cmd` file that calls `node <script>` automatically
- Git Bash on Windows: the shebang path resolves correctly via `env`

---

## 13. Versioning and Migration

### Schema Version Table

The `schema_migrations` table records applied migrations as monotonically increasing integers.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,   -- Unix epoch ms
    description TEXT
);
```

The code constant `MAX_SUPPORTED_SCHEMA_VERSION` gates which DB versions are accepted. If the DB
version exceeds this constant, the process exits with code 1.

### Migration Execution Model

```javascript
const MIGRATIONS = [
  {
    version: 1,
    description: 'initial schema',
    up: (_db) => { /* seeded by schema.sql INSERT OR IGNORE */ },
  },
  // Future:
  // { version: 2, description: '...', up: (db) => { db.exec('ALTER TABLE ...'); } },
];

function applyMigrations(db) {
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const txn = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations(version, applied_at, description) VALUES (?,?,?)'
      ).run(migration.version, Date.now(), migration.description);
    });
    txn();
  }
}
```

### Rules for Backward-Compatible Schema Evolution

1. **ADD COLUMN only**: SQLite supports `ALTER TABLE ... ADD COLUMN` for nullable or default-carrying
   columns. Never drop or rename columns in a minor version.
2. **New column must have a DEFAULT**: `ALTER TABLE events ADD COLUMN priority INTEGER DEFAULT 0`
   ensures existing rows are valid immediately.
3. **Increment `schema_migrations` version** and bump `MAX_SUPPORTED_SCHEMA_VERSION`.
4. **Code must handle NULL for new columns**: older DB rows return NULL for new columns; code must
   treat NULL as the default.

### Event Schema Versioning (`schema_version` field)

The `schema_version` field on each event describes the producer's payload schema (not the DB schema).

| Scenario | Behavior |
|----------|----------|
| `"1.0.0"` | Accepted; stored as-is |
| `"1.5.0"` (minor bump) | Accepted; forward-compatible (v1 subscriber may see unknown payload fields but must not fail) |
| `"2.0.0"` (major bump) | Rejected with WB-005 until bus is updated |
| absent | Defaulted to `"1.0.0"` |

**Forward-compatibility rule**: v1 subscribers must **ignore unknown payload fields**. Subscribers
must not fail on encountering extra keys in `payload` or `metadata`.

---

## 14. Known v1 Constraints

| Constraint | Detail | Planned Version |
|-----------|--------|----------------|
| Single-level wildcard only | `wicked.test.run.*` matches one level; `wicked.**` not supported | v2 |
| No ring-buffer on disk full | Disk full → reject-and-signal (WB-004); oldest events not auto-overwritten | v2 |
| Poll-based delivery only | No push, no WebSocket, no SSE; subscribers must poll | v2 |
| Single-host only | No multi-machine fan-out; no network transport | v2 |
| In-process sweep | TTL sweep runs inside CLI `subscribe` process; no background daemon | v2 |
| No authentication | Trust-on-same-host model; all co-installed plugins can read/write | v2+ |
| No UI/dashboard | CLI only; no event visualization UI | v2+ |
| Python binding is subprocess-only | wicked-garden and wicked-brain use `wicked-bus` CLI subprocess; no native Python SDK | v2 |

---

*Acceptance criteria cross-reference: this spec covers AC-1 through AC-31 (31 ACs). Key ACs by
section: schema (AC-2, AC-19–21), delivery (AC-7–12), CLI (AC-13–18, AC-31), integration
(AC-22–25, AC-29–30), failure modes (AC-26–27), cross-platform (AC-28).*
