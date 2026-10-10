```
          _      _            _       _
__      _(_) ___| | _____  __| |     | |__  _   _ ___
\ \ /\ / / |/ __| |/ / _ \/ _` |_____| '_ \| | | / __|
 \ V  V /| | (__|   <  __/ (_| |_____| |_) | |_| \__ \
  \_/\_/ |_|\___|_|\_\___|\__,_|     |_.__/ \__,_|___/

```

**The durable coordination fabric for AI agents and developer tools.**

At-least-once delivery with restart-durable retry (`delivery_attempts`), a dead-letter queue with
operator replay, emit-side idempotency, and disk-full recovery — no *accepted* event is lost on a
crash, a restart or a missed push, and the sweep never drops an event a consumer has not acked
unless you choose that policy (see [Delivery and retention contract](#delivery-and-retention-contract)).
Opt-in monthly tiered storage (`tiered_archive: true`) auto-splits at 10 GB and reads across tiers
transparently, so the hot working set stays small as history grows to millions of rows. Large
payloads go to a content-addressed store; causality/lineage tracing, a schema registry, and a
WB-0xx error taxonomy round it out.

Zero infrastructure: the durability substrate is **embedded SQLite (ACID/WAL)** — there's no server
to run, no network, and events stay on your machine. SQLite is the reason there's zero infra, not
the headline.

Built for agent ecosystems where multiple tools need to communicate without coupling to each other —
AI coding assistants, test runners, knowledge systems, deployment tools, or anything that benefits
from durable, event-driven coordination.

> **Status:** v2.3.3, published to npm as [`wicked-bus`](https://www.npmjs.com/package/wicked-bus)
> (also GitHub Packages as `@mikeparcewski/wicked-bus`). Pure JavaScript/ESM — no build step, no
> Rust — with hand-authored TypeScript declarations covering the entire public API. The v2 line is
> a layered coordination fabric where every layer is optional, with the v1 `emit/poll/ack/register`
> API preserved unchanged.

> **Single-host today.** Push is over a local Unix socket (a push daemon layered on durable poll, so
> a missed push never loses an event); there is **no remote/TCP event delivery**. Scale is vertical
> and temporal — the hot set stays small as history tiers out — **not** horizontal or clustered.

**The differentiator:** restart-durable, at-least-once delivery with a dead-letter queue and operator
replay — a coordination fabric with real delivery guarantees that still needs zero infrastructure to
run.

wicked-bus is the **event substrate** of the [wicked-* family](https://wickedagile.com): a
local-first stack for AI coding agents anchored by [wicked-estate](https://github.com/mikeparcewski/wicked-estate)
(the code graph + memory + knowledge), with [wicked-core](https://github.com/mikeparcewski/wicked-core) (the runtime),
[wicked-garden](https://github.com/mikeparcewski/wicked-garden) (the skill toolkit and QE domain), and
[wicked-crew](https://github.com/mikeparcewski/wicked-crew) (the workflow governor that drives your
coding-agent CLIs as governed workers).

## Quick Start

### Install

```bash
npm install -g wicked-bus
```

Or use the family installer — [`npx wicked-installer`](https://www.npmjs.com/package/wicked-installer)
installs/updates the whole wicked-\* family, bus included.

The global install puts the `wicked-bus` CLI on your PATH (a local
`npm install wicked-bus` works for the [programmatic API](#programmatic-api),
but does **not** expose the CLI — prefix CLI calls with `npx` in that case).
`better-sqlite3` is a required peer dependency (compiles a native addon).

### Initialize

```bash
wicked-bus init
```

Creates `~/.something-wicked/wicked-bus/` with a WAL-mode SQLite database.

### Emit an event

```bash
wicked-bus emit \
  --type wicked.myplugin.task.completed \
  --domain my-plugin \
  --payload '{"taskId": "abc", "status": "done"}'
```

### Subscribe to events

```bash
wicked-bus subscribe --filter 'wicked.myplugin.task.*'
```

Streams events as NDJSON. Use `--filter` with wildcards and `@domain` scoping.

## Programmatic API

Everything is exported from the package root (deep `wicked-bus/lib/...` imports
are blocked by the `exports` map), and the whole surface ships with TypeScript
declarations — `tsc --noEmit` under `nodenext` is clean with no `@types` package.

```javascript
import { emit, poll, ack, register, loadConfig, openDb } from 'wicked-bus';

const config = loadConfig();
const db = openDb(config);

// Emit
const result = emit(db, config, {
  event_type: 'wicked.mydeploy.deploy.completed',
  domain: 'my-deploy',
  subdomain: 'deploy.production',
  payload: { version: '2.0.0' },
});

// Subscribe
const sub = register(db, {
  plugin: 'my-consumer',
  role: 'subscriber',
  event_type_filter: 'wicked.mydeploy.deploy.*',
  cursor_init: 'latest',
});

// Poll
const events = poll(db, config, {
  cursor_id: sub.cursor_id,
  filter: 'wicked.mydeploy.deploy.*',
});

// Acknowledge
if (events.events.length > 0) {
  const lastId = events.events.at(-1).event_id;
  ack(db, { cursor_id: sub.cursor_id, event_id: lastId });
}

db.close();
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `init` | Create data directory and database |
| `emit` | Publish an event |
| `subscribe` | Stream events matching a filter |
| `status` | Show bus health and stats |
| `register` | Register as provider or subscriber |
| `deregister` | Soft-delete a registration |
| `list` | List registrations |
| `ack` | Acknowledge events (advance cursor) |
| `replay` | Reset a cursor to a specific position |
| `cleanup` | Run the TTL sweep: `--dry-run`, `--archive`, `--tiered`, `--unacked-policy retain\|archive\|discard`; prints the reconciliation report |

All commands output structured JSON. Errors go to stderr with codes from the WB-0xx taxonomy (WB-001 through WB-014).

## AI CLI Skills

wicked-bus ships skills for AI coding assistants (Claude Code, Codex, Antigravity, OpenCode, Cursor).

### Install skills

```bash
npm install -g wicked-bus
wicked-bus-install
```

(`wicked-bus-install` is a bin of the `wicked-bus` package — there is no
standalone `wicked-bus-install` npm package for `npx` to resolve, so install
the package first.)

Auto-detects installed CLIs and copies skills. Available skills:

| Skill | Purpose |
|-------|---------|
| `wicked-bus-init` | Initialize or connect to the bus |
| `wicked-bus-emit` | Publish events |
| `wicked-bus-subscribe` | Consume events |
| `wicked-bus-naming` | Event naming conventions |
| `wicked-bus-query` | Query and debug |
| `wicked-bus-status` | Bus health and diagnostics |
| `wicked-bus-update` | Check for and install updates |

## Why wicked-bus?

Agent ecosystems have a communication problem. Tools that should work together — test runners, code reviewers, knowledge systems, deployment pipelines — end up tightly coupled or completely siloed. wicked-bus solves this with a durable local event fabric that guarantees delivery without asking you to run anything.

- **At-least-once delivery**: cursors persist across restarts and retry is restart-durable (`delivery_attempts`). Unacked events are re-delivered — and, by default, never swept while a registered cursor still owes them; events that exhaust retries land in a dead-letter queue you can inspect and replay.
- **Durable, idempotent, crash-safe**: emit-side idempotency and disk-full recovery mean a crash, a restart, or a full disk never corrupts or duplicates the log. A rejected emit (e.g. WB-004 on a full disk) was never accepted — see the contract below.
- **Stays small as it grows**: opt-in monthly tiered storage (`tiered_archive: true` / `cleanup --tiered`) auto-splits at 10 GB and reads across tiers transparently, so the hot working set stays fast at millions of rows. The TTL sweep expires events automatically once nobody owes them — no manual cleanup, no unbounded growth — and a `subscribe()` loop whose cursor fell behind a sweep re-anchors itself to the oldest surviving event (`WB-003`, reported once with `reanchored_to` / `swept_past`) instead of wedging.
- **Zero infrastructure**: the substrate is a single embedded SQLite file (ACID/WAL). No servers to run, no ports to manage, no network — events stay on your machine.
- **Fire-and-forget**: producers never wait on consumers or on the push daemon; `emit()` itself is a synchronous local SQLite write. If the bus is not installed, callers degrade gracefully.

## Delivery and retention contract

What "durable" means here, precisely (FND-BUS-01/02/03):

- **Accepted = committed.** An event is accepted when `emit()` returns an `event_id`: the INSERT
  committed to the WAL. A thrown `emit()` (WB-004 disk full, WB-001 validation, WB-002 duplicate)
  means **nothing was accepted and nothing is retained for later** — the producer still owns the
  event. Disk-full recovery protects the *database* (integrity check, no corruption), not the
  rejected event: a producer whose notification matters must treat a throw as "not published" and
  reconcile from its own canonical record (or retry).
- **Delivery is at-least-once for accepted events.** A cursor advances only on `ack`; a handler
  side effect before the ack can repeat after a crash, so handlers must be idempotent.
- **Lifetime is `ttl_hours`** (`expires_at`, 72 h default, per-event overridable). The sweep never
  removes an event before it, and `poll()` delivers every event that still exists.
- **Unacked events are never swept by default.** An expired event that an active cursor whose
  filter matches has not acked (or that has pending retries) follows `unacked_policy`:
  `retain` (default — kept and still delivered), `archive` (copied to `events_archive`, then
  deleted) or `discard`. Every sweep returns a reconciliation report
  (`unacked: { retained|archived|discarded, cursors: [{cursor_id, count, oldest_event_id, …}] }`),
  so a loss is always named, never silent. Under `retain` an abandoned-but-registered cursor holds
  its backlog — deregister it (`wicked-bus deregister`) or choose `archive`/`discard`.
- **Dedup is a separate window** (`dedup_ttl_hours`, 24 h default): within it a reused
  `idempotency_key` is WB-002; after it the key is released from the still-living row and the new
  event is accepted.
- **Tiers are opt-in.** The default `cleanup` / background sweep is in-database
  (`archive_mode: true` keeps swept rows in `events_archive`). Monthly warm buckets
  (`archive/bus-YYYY-MM.db`, auto-split at 10 GB, read transparently by `pollResolve`) run when
  config sets `tiered_archive: true` or you pass `wicked-bus cleanup --tiered`.
- **Large payloads in CAS stay reachable from the DLQ.** CAS GC counts `$cas` references held by
  `dead_letters` snapshots, so a dead-lettered event stays replayable after its original row is
  swept.
- **Agent-native**: designed for AI coding assistants and the tools around them. Ships with skills for Claude Code, Codex, Antigravity, OpenCode, and Cursor.
- **Fully typed**: hand-authored TypeScript declarations for every public export — the event envelope (with the 4-segment `wicked.<domain>.<noun>.<verb>` grammar as a template-literal type), cursor semantics, DLQ shapes, subscribers, causality, and the `cas` namespace. Strict consumers (`tsc --noEmit`, `nodenext`) typecheck clean; a consumer-shaped fixture gates CI so the declarations can't drift from the runtime.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) -- system design and module structure
- [USERS_GUIDE.md](./USERS_GUIDE.md) -- event naming, payload conventions, integration patterns
- [reqs/SPEC.md](./reqs/SPEC.md) -- full specification

## Requirements

- Node.js >= 20.0.0
- `better-sqlite3` >= 9.0.0 (peer dependency)
- macOS, Linux, or Windows

## License

MIT
