# wicked-bus Data Domain Reference

This document describes the complete data model for wicked-bus: table schemas, event catalog,
error code reference, and configuration schema.

---

## Table of Contents

1. [Tables](#1-tables)
   - [events](#events)
   - [subscriptions](#subscriptions)
   - [cursors](#cursors)
   - [schema\_migrations](#schema_migrations)
   - [events\_archive (optional)](#events_archive-optional)
2. [Event Catalog](#2-event-catalog)
3. [Error Code Reference](#3-error-code-reference)
4. [Configuration Schema](#4-configuration-schema)
5. [File Layout](#5-file-layout)

---

## 1. Tables

### `events`

The append-only event log. All wicked-bus event writes land here.

**AC**: AC-4, AC-19

```sql
CREATE TABLE IF NOT EXISTS events (
    event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type        TEXT    NOT NULL CHECK(length(event_type) <= 64),
    domain            TEXT    NOT NULL CHECK(length(domain) <= 64),
    subdomain         TEXT    NOT NULL DEFAULT '' CHECK(length(subdomain) <= 64),
    payload           TEXT    NOT NULL,
    schema_version    TEXT    NOT NULL DEFAULT '1.0.0',
    idempotency_key   TEXT    NOT NULL UNIQUE,
    emitted_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    dedup_expires_at  INTEGER NOT NULL,
    metadata          TEXT
);
```

**Indexes**:
```sql
CREATE INDEX IF NOT EXISTS idx_events_event_type       ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_domain           ON events(domain);
CREATE INDEX IF NOT EXISTS idx_events_subdomain        ON events(subdomain);
CREATE INDEX IF NOT EXISTS idx_events_emitted_at       ON events(emitted_at);
CREATE INDEX IF NOT EXISTS idx_events_expires_at       ON events(expires_at);
CREATE INDEX IF NOT EXISTS idx_events_dedup_expires_at ON events(dedup_expires_at);
-- idempotency_key covered by UNIQUE constraint index
-- composite index for domain-filtered polls
CREATE INDEX IF NOT EXISTS idx_events_type_domain ON events(event_type, domain);
```

**Column descriptions**:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `event_id` | INTEGER | No | Auto-increment primary key. Assigned by DB on insert; never supplied by producer. Used as cursor value — integer ordering guarantees delivery order within a topic. |
| `event_type` | TEXT | No | Dot-separated event type. Max 64 chars. Pattern: `wicked.<noun>.<verb>` (three segments). Example: `wicked.run.completed`. Publisher identity is carried in `domain`, not in the type string. |
| `domain` | TEXT | No | The wicked-* domain that emitted the event. Max 64 chars. Example: `wicked-testing`, `wicked-garden`, `wicked-brain`. Used with `subdomain` to disambiguate events that share the same `event_type` (e.g. `wicked.project.created` from `wicked-testing` vs. `wicked-garden`). |
| `subdomain` | TEXT | No | Functional area within the domain. Max 64 chars. Dot-separated. Defaults to empty string `''` when not supplied. Examples: `test.run`, `crew.phase`, `brain.memory`. Enables subscribers to filter within a domain's events without inspecting the payload. |
| `payload` | TEXT | No | JSON text. Maximum size governed by `max_payload_bytes` config (default 1 MB). Must be a valid JSON object. |
| `schema_version` | TEXT | No | Semver string declaring the producer's payload schema. Default `"1.0.0"`. v1 bus accepts `1.x`; major >= 2 triggers WB-005. |
| `idempotency_key` | TEXT | No | UUID v4 string. Auto-generated if not supplied by producer. UNIQUE constraint enforces deduplication at DB level. Row exists as long as `dedup_expires_at` is in the future. |
| `emitted_at` | INTEGER | No | Unix epoch milliseconds. Set by wicked-bus at write time. |
| `expires_at` | INTEGER | No | Unix epoch milliseconds. `emitted_at + (ttl_hours * 3_600_000)`. **Visibility filter**: events past this timestamp are excluded from subscriber poll results. The row still exists until `dedup_expires_at`. |
| `dedup_expires_at` | INTEGER | No | Unix epoch milliseconds. `emitted_at + (dedup_ttl_hours * 3_600_000)`. **Row deletion trigger**: the background sweep deletes rows where `dedup_expires_at < now()`. This frees the `idempotency_key` UNIQUE slot. Default: `emitted_at + 24h`. |
| `metadata` | TEXT | Yes | Nullable JSON text. Arbitrary producer-supplied context (e.g. hostname, node version). Not validated by wicked-bus. |

**Two-timer semantics**: with defaults `dedup_ttl_hours=24` and `ttl_hours=72`:
- Events become invisible to polls at T+72h (`expires_at`)
- Event rows are deleted at T+24h (`dedup_expires_at`)
- Rows are deleted **before** they become invisible — a subscriber with a cursor older than 24h
  will receive WB-003 because the rows no longer exist

**Write behavior**:
- `event_id`: assigned by SQLite AUTOINCREMENT
- `idempotency_key`: generated as UUID v4 if not supplied by producer
- `emitted_at`: `Date.now()` at write time
- `expires_at`: `emitted_at + config.ttl_hours * 3_600_000`
- `dedup_expires_at`: `emitted_at + config.dedup_ttl_hours * 3_600_000`

---

### `subscriptions`

Tracks registered providers and subscribers. Both use this table; distinguished by the `role` column.

**AC**: AC-5, AC-6, AC-20

```sql
CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id          TEXT    PRIMARY KEY,
    domain                   TEXT    NOT NULL,
    role                     TEXT    NOT NULL CHECK(role IN ('provider','subscriber')),
    event_type_filter        TEXT    NOT NULL,
    schema_version           TEXT,
    registered_at            INTEGER NOT NULL,
    deregistered_at          INTEGER,
    health_check_interval_ms INTEGER DEFAULT 60000
);
```

**Indexes**:
```sql
CREATE INDEX IF NOT EXISTS idx_subscriptions_domain ON subscriptions(domain);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active
    ON subscriptions(domain, role)
    WHERE deregistered_at IS NULL;
```

**Column descriptions**:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `subscription_id` | TEXT | No | UUID v4. Primary key. Returned to the caller on registration. |
| `domain` | TEXT | No | The wicked-* domain registering. Example: `wicked-testing`, `wicked-garden`. |
| `role` | TEXT | No | `'provider'` or `'subscriber'`. CHECK constraint enforces the enum. |
| `event_type_filter` | TEXT | No | For providers: comma-separated event types they will emit. For subscribers: the filter pattern — type wildcard with optional `@<domain>` suffix (e.g. `wicked.run.*@wicked-testing`). |
| `schema_version` | TEXT | Yes | Semver. Declared by providers; NULL for subscribers. |
| `registered_at` | INTEGER | No | Unix epoch milliseconds. Set at registration time. |
| `deregistered_at` | INTEGER | Yes | Unix epoch milliseconds. NULL = active. Set by `wicked-bus deregister`. Records are soft-deleted (not hard-deleted). |
| `health_check_interval_ms` | INTEGER | Yes | Default 60000. Reserved for v2 health-check polling. Not enforced in v1. |

**Soft-delete behavior**: `wicked-bus deregister` sets `deregistered_at = now()`. The row is not
removed from the table. `wicked-bus list` excludes deregistered rows by default; use
`--include-deregistered` to see them. The partial index `idx_subscriptions_active` covers only
active rows (`deregistered_at IS NULL`) for efficient lookup.

---

### `cursors`

Per-subscriber cursor tracking. Each subscriber has exactly one cursor row per active registration.

**AC**: AC-7, AC-21, AC-31

```sql
CREATE TABLE IF NOT EXISTS cursors (
    cursor_id         TEXT    PRIMARY KEY,
    subscription_id   TEXT    NOT NULL
                        REFERENCES subscriptions(subscription_id)
                        ON DELETE RESTRICT,
    last_event_id     INTEGER NOT NULL DEFAULT 0,
    acked_at          INTEGER,
    created_at        INTEGER NOT NULL,
    deregistered_at   INTEGER
);
```

**Indexes**:
```sql
CREATE INDEX IF NOT EXISTS idx_cursors_subscription_id ON cursors(subscription_id);
CREATE INDEX IF NOT EXISTS idx_cursors_active
    ON cursors(subscription_id)
    WHERE deregistered_at IS NULL;
```

**Column descriptions**:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `cursor_id` | TEXT | No | UUID v4. Primary key. Returned to the subscriber on registration. |
| `subscription_id` | TEXT | No | Foreign key to `subscriptions(subscription_id)`. ON DELETE RESTRICT prevents orphaned cursors from hanging around if a subscription is hard-deleted (soft-delete is the norm). |
| `last_event_id` | INTEGER | No | Default 0. The `event_id` of the last successfully acknowledged event. Polls query `WHERE event_id > last_event_id`. Initialized to `0` (cursor-init `oldest`) or `MAX(event_id)` (cursor-init `latest`). |
| `acked_at` | INTEGER | Yes | Unix epoch milliseconds. NULL until the first successful ack. Updated atomically with `last_event_id` on each `wicked-bus ack` call. |
| `created_at` | INTEGER | No | Unix epoch milliseconds. Set when the cursor row is created during subscriber registration. |
| `deregistered_at` | INTEGER | Yes | Unix epoch milliseconds. NULL = active cursor. Set by `wicked-bus deregister`. This is a **soft delete** — the row is NOT removed, allowing inspection of historical subscriber positions. |

**Ack atomicity**: the `UPDATE cursors SET last_event_id = ?, acked_at = ?` is always executed
inside a SQLite transaction. There is no partial ack — either both columns are updated or neither.

**Cursor initialization**:
- `cursor-init=oldest`: `last_event_id = 0` (polls will return all non-expired events)
- `cursor-init=latest`: `last_event_id = MAX(event_id)` at registration time, or `0` if no events exist

**`ON DELETE RESTRICT`**: if code ever attempts to hard-delete a `subscriptions` row while cursor
rows still reference it, SQLite will raise a foreign key violation. This protects against
accidental data loss. Always use the soft-delete path (`deregistered_at = now()`) via `wicked-bus deregister`.

---

### `schema_migrations`

Tracks applied schema migrations. Used to detect version mismatches and gate DB access by older
versions of wicked-bus.

**AC**: AC-2

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,   -- Unix epoch ms
    description TEXT
);

-- Seed v1 on first init
INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
VALUES (1, unixepoch() * 1000, 'initial schema');
```

**Column descriptions**:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `version` | INTEGER | No | Monotonically increasing migration version number (1, 2, 3, …). |
| `applied_at` | INTEGER | No | Unix epoch milliseconds. When the migration was applied. |
| `description` | TEXT | Yes | Human-readable description of the migration. |

**Version gating**: on DB open, `lib/db.js` reads the max `version` from this table. If it exceeds
`MAX_SUPPORTED_SCHEMA_VERSION`, the process exits with code 1 and a message directing the user to
upgrade wicked-bus.

---

### `events_archive` (optional)

Created and used only when `config.archive_mode = true`. Has the same column set as `events`.
Expired event rows are moved here before deletion during the sweep.

```sql
-- Created by lib/sweep.js when archive_mode is enabled:
CREATE TABLE IF NOT EXISTS events_archive (
    event_id          INTEGER PRIMARY KEY,
    event_type        TEXT    NOT NULL,
    domain            TEXT    NOT NULL,
    subdomain         TEXT    NOT NULL DEFAULT '',
    payload           TEXT    NOT NULL,
    schema_version    TEXT    NOT NULL DEFAULT '1.0.0',
    idempotency_key   TEXT    NOT NULL,
    emitted_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    dedup_expires_at  INTEGER NOT NULL,
    metadata          TEXT
);
```

`INSERT OR IGNORE INTO events_archive SELECT * FROM events WHERE dedup_expires_at < ?` — the
`OR IGNORE` prevents failures if an archived row is re-inserted on a subsequent sweep (idempotent).

---

## 2. Event Catalog

### Naming Convention

```
wicked.<noun>.<past-tense-verb>
```

All v1 catalog event types are **three segments**. The publisher is carried in `source_plugin`; the
functional area within the publisher is carried in `subdomain`. Do not embed the plugin name in the
type string — `wicked.run.completed` emitted by `wicked-testing` and `wicked.run.completed` emitted
by a future CI plugin share the same type because they represent the same semantic event.

**Filter syntax**: subscribers filter on `event_type` with optional source scoping:

| Filter | Matches |
|--------|---------|
| `wicked.run.*` | All run lifecycle events from **any** publisher |
| `wicked.run.*@wicked-testing` | All run lifecycle events from `wicked-testing` only |
| `wicked.memory.*@wicked-brain` | All brain memory events |
| `*@wicked-garden` | Every event emitted by `wicked-garden` |

The `@<source_plugin>` suffix is parsed server-side at poll time: the left side is a type wildcard,
the right side is an exact `source_plugin` match. The `@` character is reserved and may not appear
in event type strings or plugin names.

Do not construct event types dynamically — use an explicit mapping (see `WICKED_BUS_EVENT_MAP` in
the integration spec).

---

### Run Lifecycle

Events emitted when a test or processing run starts, finishes, or fails.

| Event Type | `subdomain` | Domain | Trigger | Required Payload Fields | Optional Payload Fields |
|-----------|-------------|--------------|---------|------------------------|------------------------|
| `wicked.run.started` | `test.run` | `wicked-testing`  | Test run begins | `runId`, `projectId`, `scenarioId`, `startedAt` | — |
| `wicked.run.completed` | `test.run` | `wicked-testing`  | Run finishes; all steps executed (pass or fail) | `runId`, `projectId`, `scenarioId`, `status`, `duration_ms` | `evidencePath` |
| `wicked.run.partial` | `test.run` | `wicked-testing`  | Run finishes with SKIPPed steps (tool unavailable) | `runId`, `projectId`, `scenarioId`, `skippedSteps`, `duration_ms` | `reason` |
| `wicked.run.failed` | `test.run` | `wicked-testing`  | Run aborts due to exception or timeout | `runId`, `projectId`, `error`, `duration_ms` | — |

**Wildcard**: `wicked.run.*` — all run events from any publisher. `wicked.run.*@wicked-testing` — testing runs only.

---

### Phase Lifecycle

Events emitted by `wicked-garden` as crew project phases move through their lifecycle.

| Event Type | `subdomain` | Domain | Trigger | Required Payload Fields | Optional Payload Fields |
|-----------|-------------|--------------|---------|------------------------|------------------------|
| `wicked.phase.started` | `crew.phase` | `wicked-garden` | Phase transitions to in_progress | `projectId`, `phaseName`, `startedAt` | — |
| `wicked.phase.completed` | `crew.phase` | `wicked-garden` | Phase passes its gate and is approved | `projectId`, `phaseName`, `duration_ms` | `deliverables` |
| `wicked.phase.skipped` | `crew.phase` | `wicked-garden` | Phase skipped (condition not met or explicit skip) | `projectId`, `phaseName`, `reason` | — |
| `wicked.phase.failed` | `crew.phase` | `wicked-garden` | Phase fails its gate | `projectId`, `phaseName`, `gateErrors` | — |

**Wildcard**: `wicked.phase.*` — all phase lifecycle events.

---

### Gate Lifecycle

Events emitted when a crew quality gate runs or its result is overridden.

| Event Type | `subdomain` | Domain | Trigger | Required Payload Fields | Optional Payload Fields |
|-----------|-------------|--------------|---------|------------------------|------------------------|
| `wicked.gate.run` | `crew.gate` | `wicked-garden` | Gate evaluation executes for a phase | `projectId`, `phaseName`, `gateType`, `result` | `conditions` |
| `wicked.gate.passed` | `crew.gate` | `wicked-garden` | Gate returns APPROVE | `projectId`, `phaseName`, `gateType` | — |
| `wicked.gate.overridden` | `crew.gate` | `wicked-garden` | Gate bypassed with override flag | `projectId`, `phaseName`, `reason`, `overriddenBy` | — |

---

### Project Lifecycle

Events emitted when a project is created or its lifecycle state changes. Shared type across publishers — use `source_plugin` to distinguish crew projects from test projects.

| Event Type | `subdomain` | Domain | Trigger | Required Payload Fields | Optional Payload Fields |
|-----------|-------------|--------------|---------|------------------------|------------------------|
| `wicked.project.created` | `crew.project` | `wicked-garden` | New crew project initialized | `projectId`, `name`, `description` | — |
| `wicked.project.created` | `test.project` | `wicked-testing`  | New test project initialized | `projectId`, `name` | — |
| `wicked.project.archived` | `crew.project` | `wicked-garden` | Crew project archived | `projectId`, `archivedAt` | — |

---

### Verdict & Evidence

Events emitted when a test verdict is recorded or evidence artifacts are collected.

| Event Type | `subdomain` | Domain | Trigger | Required Payload Fields | Optional Payload Fields |
|-----------|-------------|--------------|---------|------------------------|------------------------|
| `wicked.verdict.issued` | `test.verdict` | `wicked-testing`  | Reviewer verdict recorded for a run | `verdictId`, `runId`, `verdict`, `reviewer` | — |
| `wicked.evidence.collected` | `test.evidence` | `wicked-testing`  | Evidence artifacts written after run | `runId`, `projectId`, `artifactCount`, `evidencePath` | — |
| `wicked.pipeline.completed` | `test.acceptance` | `wicked-testing`  | 3-agent acceptance pipeline (writer→executor→reviewer) finishes | `runId`, `projectId`, `verdict`, `duration_ms` | — |

---

### Scenario & Strategy

Events emitted when test scenarios or strategies are created or authored.

| Event Type | `subdomain` | Domain | Trigger | Required Payload Fields | Optional Payload Fields |
|-----------|-------------|--------------|---------|------------------------|------------------------|
| `wicked.scenario.created` | `test.scenario` | `wicked-testing`  | New test scenario created | `scenarioId`, `projectId`, `name`, `format_version` | — |
| `wicked.scenario.authored` | `test.scenario` | `wicked-testing`  | Scenario authored by agent | `scenarioId`, `projectId` | — |
| `wicked.strategy.generated` | `test.strategy` | `wicked-testing`  | Test strategy generated | `projectId` | `scenarioCount` |

---

### Memory & Knowledge

Events emitted by `wicked-brain` as memory chunks are stored, updated, or consolidated.

| Event Type | `subdomain` | Domain | Trigger | Required Payload Fields | Optional Payload Fields |
|-----------|-------------|--------------|---------|------------------------|------------------------|
| `wicked.memory.stored` | `brain.memory` | `wicked-brain` | Memory chunk written to store | `chunkId`, `tier`, `tags` | `size_bytes` |
| `wicked.memory.updated` | `brain.memory` | `wicked-brain` | Memory chunk updated | `chunkId`, `tier`, `tags` | — |
| `wicked.memory.expired` | `brain.memory` | `wicked-brain` | Memory chunk expired from store | `chunkId`, `tier` | — |
| `wicked.memory.consolidated` | `brain.memory` | `wicked-brain` | Consolidation cycle ran; working memories promoted or archived | `promotedCount`, `archivedCount`, `duration_ms` | — |
| `wicked.knowledge.updated` | `brain.index` | `wicked-brain` | Knowledge index rebuilt after ingest or retag | `indexSize`, `chunkCount`, `duration_ms` | — |
| `wicked.chunk.indexed` | `brain.fts` | `wicked-brain` | Non-memory content chunk added to FTS index | `chunkId`, `sourcePath`, `chunkType` | `size_bytes` |
| `wicked.article.synthesized` | `brain.wiki` | `wicked-brain` | Wiki article compiled from indexed chunks | `articleId`, `title`, `chunkCount` | — |

**Wildcard**: `wicked.memory.*@wicked-brain` — all brain memory lifecycle events.

---

### Payload Field Reference

| Field | Type | Example | Notes |
|-------|------|---------|-------|
| `runId` | string | `"run-abc123"` | Run identifier |
| `projectId` | string | `"proj-xyz"` | Project identifier |
| `scenarioId` | string | `"scen-456"` | Scenario identifier |
| `startedAt` | integer | `1744393800000` | Unix epoch ms |
| `status` | string | `"passed"`, `"failed"` | Run completion status |
| `duration_ms` | integer | `1840` | Duration in milliseconds |
| `evidencePath` | string | `".wicked-testing/runs/run-abc123"` | Relative path to evidence |
| `artifactCount` | integer | `12` | Number of evidence artifacts |
| `skippedSteps` | array | `["step-3", "step-7"]` | Step IDs skipped due to tool unavailability |
| `error` | string | `"Timeout after 30s"` | Error message on failure |
| `verdictId` | string | `"verdict-789"` | Verdict identifier |
| `verdict` | string | `"pass"`, `"fail"` | Verdict outcome |
| `reviewer` | string | `"agent"`, `"human"` | Who issued the verdict |
| `phaseName` | string | `"design"` | Phase name in crew project |
| `gateType` | string | `"execution"`, `"strategy"` | Gate type |
| `result` | string | `"APPROVE"`, `"CONDITIONAL"`, `"REJECT"` | Gate result |
| `conditions` | array | `[{"id":"C1","severity":"moderate"}]` | Gate conditions (CONDITIONAL only) |
| `deliverables` | array | `["architecture.md"]` | Phase output files |
| `gateErrors` | array | `["AC-3 not met"]` | Gate failure reasons |
| `overriddenBy` | string | `"just-finish"` | Who or what issued the override |
| `archivedAt` | integer | `1744393800000` | Unix epoch ms |
| `chunkId` | string | `"mem-abc123"` | Brain chunk identifier (camelCase) |
| `tier` | string | `"semantic"`, `"episodic"`, `"working"` | Memory tier |
| `tags` | array | `["crew", "pattern"]` | Metadata tags |
| `size_bytes` | integer | `4096` | Chunk size |
| `indexSize` | integer | `1024` | Knowledge index entry count |
| `chunkCount` | integer | `88` | Total chunks in index or article |
| `promotedCount` | integer | `3` | Working memories promoted in consolidation cycle |
| `archivedCount` | integer | `7` | Memories archived in consolidation cycle |
| `sourcePath` | string | `"src/lib/emit.js"` | Source file path for indexed chunk |
| `chunkType` | string | `"code"`, `"doc"`, `"wiki"` | Content type of indexed chunk |
| `articleId` | string | `"wiki-auth-flow"` | Wiki article identifier |
| `title` | string | `"Authentication Flow"` | Wiki article title |

---

## 3. Error Code Reference

All errors use the same JSON envelope format:

```json
{
  "error": "WB-001",
  "code": "INVALID_EVENT_SCHEMA",
  "message": "Human-readable description",
  "context": { ... }
}
```

The `error` field is the code (e.g. `"WB-001"`); `code` is the machine-readable name.

### WB-001: INVALID_EVENT_SCHEMA

| Property | Value |
|----------|-------|
| **CLI exit code** | 1 |
| **Trigger** | Missing required field, type violation, payload too large, invalid event_type pattern |
| **DB write** | No — rejected before any DB interaction |
| **Source** | `lib/validate.js` |
| **AC** | AC-3 |

**Context fields**:
```json
{
  "received_fields": ["domain", "payload"],
  "missing_fields": ["event_type"],
  "violation": "missing required field: event_type"
}
```

**Validation rules** (all must pass):
- `event_type`: required; string; max 64 chars; exactly three dot-separated segments; matches `/^wicked\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/`; no `@` character
- `domain`: required; string; max 64 chars; no `@` character
- `subdomain`: optional; string; max 64 chars; defaults to `''` if not supplied
- `payload`: required; valid JSON-serializable object; `JSON.stringify(payload).length <= max_payload_bytes`
- `schema_version` (if present): matches semver `/^\d+\.\d+\.\d+$/`

---

### WB-002: DUPLICATE_EVENT

| Property | Value |
|----------|-------|
| **CLI exit code** | 2 |
| **Trigger** | `idempotency_key` already exists in `events` table |
| **DB write** | No — caught on `SQLITE_CONSTRAINT_UNIQUE` |
| **Source** | `lib/emit.js` |
| **AC** | AC-9 |

**Context fields**:
```json
{
  "original_event_id": 42,
  "idempotency_key": "550e8400-..."
}
```

`original_event_id` is returned so callers can idempotently confirm the event exists without a
second write. This supports exactly-once producer patterns.

The deduplication window is governed by `dedup_ttl_hours` (default 24h). Once `dedup_expires_at`
passes, the row is swept and the key is freed — a new event with the same key is accepted.

---

### WB-003: CURSOR_BEHIND_TTL_WINDOW

| Property | Value |
|----------|-------|
| **CLI exit code** | 3 (subscribe command) |
| **Trigger** | Subscriber's `last_event_id` cursor is before the oldest available row (rows swept by `dedup_expires_at`) |
| **DB write** | No — returned as a warning; cursor not auto-reset |
| **Source** | `lib/poll.js` |
| **AC** | AC-12 |

**Context fields**:
```json
{
  "cursor_last_event_id": 15,
  "oldest_available_event_id": 42
}
```

**Detection logic**: uses `MIN(event_id)` from **all actual rows in the table** — no `WHERE` filter on `expires_at`. Row deletion is triggered by `dedup_expires_at`, so rows may be deleted while `expires_at` has not yet passed. Filtering on `expires_at` would return wrong results under default config (rows deleted at T+24h, visibility expires at T+72h).

```javascript
// CORRECT: no WHERE clause — check actual row existence, not visibility
const oldest = db.prepare(
  'SELECT MIN(event_id) as min_id FROM events'
).get();

if (cursor.last_event_id < (oldest?.min_id ?? 0) - 1) {
  throw new WBError('WB-003', 'CURSOR_BEHIND_TTL_WINDOW', { ... });
}
```

> **Do NOT use** `WHERE expires_at > ?` — this would miss the case where rows were deleted by the dedup sweep before their visibility TTL expired.

**Subscriber must**:
- Call `wicked-bus replay --cursor-id X --from-event-id <oldest_available_event_id>` to reset forward, OR
- Halt and alert operators

---

### WB-004: DISK_FULL

| Property | Value |
|----------|-------|
| **CLI exit code** | 4 |
| **Trigger** | SQLite write returns `SQLITE_FULL` or Node.js raises `ENOSPC` |
| **DB write** | No — rejected to avoid corruption |
| **Source** | `lib/emit.js` |
| **AC** | AC-26 |

**Context fields**:
```json
{
  "sqlite_error": "SQLITE_FULL",
  "db_path": "/home/alice/.something-wicked/wicked-bus/bus.db"
}
```

**v1 behavior**: wicked-bus does NOT delete old events to make space (ring-buffer semantics deferred
to v2). After catching the error, wicked-bus closes and re-opens the DB connection to verify it is
not corrupted, then returns WB-004.

Callers in graceful-degradation mode swallow this error silently.

---

### WB-005: SCHEMA_VERSION_UNSUPPORTED

| Property | Value |
|----------|-------|
| **CLI exit code** | 5 |
| **Trigger** | Producer declares `schema_version` with major version > `MAX_SUPPORTED_SCHEMA_MAJOR` (currently 1) |
| **DB write** | No — rejected before write |
| **Source** | `lib/validate.js` |
| **AC** | AC-27 |

**Context fields**:
```json
{
  "declared": "2.0.0",
  "max_supported": "1.x"
}
```

v1 bus accepts `"1.0.0"`, `"1.5.0"`, etc. (any `1.x`). Major version 2+ is rejected until the
bus is upgraded. Minor-version bumps within `1.x` are accepted with forward-compatibility
(subscribers must ignore unknown payload fields).

---

### WB-006: CURSOR_NOT_FOUND

| Property | Value |
|----------|-------|
| **CLI exit code** | 6 |
| **Trigger** | `ack` call references a `cursor_id` that does not exist or has `deregistered_at` set |
| **DB write** | No — UPDATE affects 0 rows; error is raised |
| **Source** | `lib/poll.js`, `cmd-ack.js` |
| **AC** | AC-7 (ack atomicity) |

**Context fields**:
```json
{
  "cursor_id": "c3d4e5f6-...",
  "reason": "cursor not found or deregistered"
}
```

The caller must re-register (via `wicked-bus register`) to obtain a new cursor. Existing events in
the log are not affected.

---

## 4. Configuration Schema

**File**: `<data-dir>/config.json`  
**Written by**: `wicked-bus init`  
**Read by**: `lib/config.js` on every command invocation

### Schema

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

### Field Definitions

| Field | JSON Type | Default | Valid Range | Description |
|-------|-----------|---------|-------------|-------------|
| `ttl_hours` | number | `72` | >= `dedup_ttl_hours` | Event visibility window in hours. Events with `expires_at < now()` are excluded from polls. Used to compute `expires_at = emitted_at + ttl_hours * 3_600_000`. |
| `dedup_ttl_hours` | number | `24` | <= `ttl_hours`, >= 1 | Deduplication and row lifetime window in hours. Rows with `dedup_expires_at < now()` are deleted by the sweep. Used to compute `dedup_expires_at = emitted_at + dedup_ttl_hours * 3_600_000`. Must not exceed `ttl_hours`. |
| `sweep_interval_minutes` | number | `15` | >= 0 | Background TTL sweep frequency in minutes. `0` disables automatic sweep (manual `wicked-bus cleanup` only). |
| `archive_mode` | boolean | `false` | `true`\|`false` | If `true`, expired rows are moved to `events_archive` before deletion. If `false`, rows are hard-deleted. |
| `log_level` | string | `"warn"` | `"debug"`, `"info"`, `"warn"`, `"error"` | Logging verbosity for wicked-bus internal messages. |
| `db_path` | string\|null | `null` | absolute path | Absolute path override for `bus.db`. If `null`, resolved to `<data-dir>/bus.db`. Useful for mounting the DB on a ramdisk or non-default volume. |
| `max_payload_bytes` | number | `1048576` | >= 1 | Maximum serialized payload size in bytes (default 1 MB). Events exceeding this are rejected with WB-001 (INVALID_EVENT_SCHEMA). |

### Validation Rules

Applied by `lib/config.js` after merging user config with defaults:

1. `dedup_ttl_hours` must be <= `ttl_hours` — otherwise the sweep would delete rows that should
   still be visible to polls
2. `sweep_interval_minutes` must be >= 0
3. `max_payload_bytes` must be >= 1
4. `log_level` must be one of `["debug", "info", "warn", "error"]`

### Environment Overrides

| Variable | Overrides | Priority |
|----------|-----------|----------|
| `WICKED_BUS_DATA_DIR` | Data directory path | Highest (above config) |
| `DEBUG=wicked-bus` | Enables debug-level graceful degradation logs | Process-level |

---

## 5. File Layout

All wicked-bus data files live under the resolved data directory (see cross-platform resolution in
SPEC.md Section 12).

```
~/.something-wicked/wicked-bus/
├── bus.db                           # SQLite database (WAL mode)
├── bus.db-wal                       # SQLite WAL file (auto-created)
├── bus.db-shm                       # SQLite shared memory file (auto-created)
├── config.json                      # Configuration (written by wicked-bus init)
└── providers/
    ├── wicked-testing.json          # Provider sidecar for wicked-testing
    ├── wicked-garden.json           # Provider sidecar for wicked-garden
    └── wicked-brain.json            # Provider sidecar for wicked-brain
```

**`bus.db`**: the primary SQLite database. Contains `events`, `subscriptions`, `cursors`,
`schema_migrations` tables, and optionally `events_archive`.

**`bus.db-wal` / `bus.db-shm`**: WAL mode auxiliary files. Auto-created by SQLite; do not modify
or delete while the DB is open. Safe to delete when the DB is closed (SQLite checkpoints on close).

**`config.json`**: default values written by `wicked-bus init`. User-editable. Missing fields fall
back to defaults. Malformed JSON is ignored (defaults used).

**`providers/<plugin-name>.json`**: informational sidecar written by `wicked-bus register --role provider`.
Removed by `wicked-bus deregister`. The authoritative record is always the `subscriptions` table row.
Human-readable for inspection without a SQLite client.
