# Architecture

## Overview

wicked-bus is a local-first event bus for AI agents and developer tools. No servers, no network transport, no message queues. Just SQLite.

Events are written to an append-only `events` table and consumed via cursor-based polling. Each subscriber maintains its own cursor position. Events are swept (deleted) after a configurable TTL.

```
Producer ──> emit() ──> SQLite (events table) ──> poll() ──> Consumer
                                                     │
                                                     └── cursor tracks position
```

## Module Layers

```
┌─────────────────────────────────────────────┐
│  CLI Layer                                   │
│  cli.js + 10 cmd-*.js command modules        │
├─────────────────────────────────────────────┤
│  API Layer                                   │
│  index.js (ESM re-exports)                   │
│  index.cjs (CJS shim)                        │
├─────────────────────────────────────────────┤
│  Feature Layer                               │
│  emit.js    poll.js    sweep.js    register.js│
├─────────────────────────────────────────────┤
│  Core Layer                                  │
│  db.js    config.js    validate.js            │
├─────────────────────────────────────────────┤
│  Foundation Layer                            │
│  paths.js    errors.js    schema.sql          │
└─────────────────────────────────────────────┘
```

Each layer depends only on the layer below it. No circular dependencies.

## SQLite Schema

Four tables, all created with `IF NOT EXISTS` (idempotent):

### events

The append-only event log.

| Column | Type | Notes |
|--------|------|-------|
| `event_id` | INTEGER PK | Auto-increment |
| `event_type` | TEXT | Semantic event name, max 128 chars |
| `domain` | TEXT | Publishing plugin name, max 64 chars |
| `subdomain` | TEXT | Functional area within the plugin, max 64 chars, default `''` |
| `payload` | TEXT | JSON object |
| `schema_version` | TEXT | Semver, default `1.0.0` |
| `idempotency_key` | TEXT UNIQUE | UUID v4 for deduplication |
| `emitted_at` | INTEGER | Unix epoch ms |
| `expires_at` | INTEGER | Visibility cutoff (emitted_at + 72h default) |
| `dedup_expires_at` | INTEGER | Row deletion cutoff (emitted_at + 24h default) |
| `metadata` | TEXT | Optional JSON |

Indexes on: `event_type`, `domain`, `subdomain`, `(event_type, domain)`, `emitted_at`, `expires_at`, `dedup_expires_at`.

### subscriptions

Provider and subscriber registrations.

| Column | Type | Notes |
|--------|------|-------|
| `subscription_id` | TEXT PK | UUID |
| `plugin` | TEXT | Plugin name |
| `role` | TEXT | `provider` or `subscriber` |
| `event_type_filter` | TEXT | Filter pattern |
| `deregistered_at` | INTEGER | NULL = active, set on deregister |

### cursors

Per-subscriber read position.

| Column | Type | Notes |
|--------|------|-------|
| `cursor_id` | TEXT PK | UUID |
| `subscription_id` | TEXT FK | References subscriptions |
| `last_event_id` | INTEGER | Last acknowledged event (0 = beginning) |
| `acked_at` | INTEGER | Timestamp of last ack |

### schema_migrations

Version tracking for future schema changes.

## Data Flows

### Emit Path

1. `validateEvent()` -- checks event_type pattern, domain, payload size, schema_version
2. Generate `idempotency_key` (UUID v4) if not provided
3. Compute `expires_at` and `dedup_expires_at` from config TTLs
4. `INSERT INTO events` -- SQLite UNIQUE constraint on `idempotency_key` prevents duplicates
5. On duplicate: catch `SQLITE_CONSTRAINT_UNIQUE`, return WB-002 with original `event_id`

### Poll Path

1. Load cursor position (`last_event_id`) from cursors table
2. WB-003 check: compare cursor to `MIN(event_id)` from all rows (not filtered by expires_at)
3. Parse filter string: split on `@` for domain scoping, handle `*` wildcards
4. `SELECT FROM events WHERE event_id > cursor AND expires_at > now` with filter conditions
5. Return events batch (up to `batch_size`)

### Sweep Path

1. `DELETE FROM events WHERE dedup_expires_at < now`
2. Optional: `INSERT INTO events_archive` before deletion (archive mode)
3. Return count of deleted rows

### Filter Matching

| Pattern | SQL Generated |
|---------|--------------|
| `wicked.run.completed` | `event_type = 'wicked.run.completed'` |
| `wicked.run.*` | `event_type LIKE 'wicked.run.%' AND event_type NOT LIKE 'wicked.run.%.%'` |
| `*@wicked-brain` | `domain = 'wicked-brain'` |
| `wicked.run.*@wicked-testing` | Both type LIKE and domain = |

## Two-Timer TTL

Events have two expiry timestamps:

```
emit ──────── dedup_expires_at (24h) ──────── expires_at (72h)
               │                                │
               └─ Row is deleted by sweep        └─ Row is invisible to poll
```

With defaults, deletion happens at 24h but invisibility at 72h -- meaning rows are deleted before they become invisible. This is intentional: the dedup window is shorter than the visibility window.

## Cross-Platform

`paths.js` resolves the data directory:

1. `WICKED_BUS_DATA_DIR` env var (highest priority)
2. Platform detection:
   - macOS/Linux: `$HOME/.something-wicked/wicked-bus/`
   - Windows: `%APPDATA%` or `%USERPROFILE%` + `.something-wicked/wicked-bus/`
3. All paths use `node:path.join()` for separator safety

## Error Codes

| Code | Name | Exit | Trigger |
|------|------|------|---------|
| WB-001 | INVALID_EVENT_SCHEMA | 1 | Validation failure |
| WB-002 | DUPLICATE_EVENT | 2 | Duplicate idempotency_key |
| WB-003 | CURSOR_BEHIND | 3 | Cursor behind oldest event |
| WB-004 | DISK_FULL | 4 | SQLite disk full |
| WB-005 | SCHEMA_VERSION_UNSUPPORTED | 5 | schema_version > 1.x |
| WB-006 | CURSOR_NOT_FOUND | 6 | Invalid or deregistered cursor |

All errors produce structured JSON to stderr:

```json
{
  "error": "WB-001",
  "code": "INVALID_EVENT_SCHEMA",
  "message": "...",
  "context": { ... }
}
```

## v1 Constraints

- Single-host only (no network transport)
- No push delivery (poll-based only)
- No background daemon (sweep runs in-process or via CLI)
- No authentication
- No multi-level wildcards (`wicked.**` is not supported)
