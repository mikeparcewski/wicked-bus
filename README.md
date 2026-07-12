```
          _      _            _       _
__      _(_) ___| | _____  __| |     | |__  _   _ ___
\ \ /\ / / |/ __| |/ / _ \/ _` |_____| '_ \| | | / __|
 \ V  V /| | (__|   <  __/ (_| |_____| |_) | |_| \__ \
  \_/\_/ |_|\___|_|\_\___|\__,_|     |_.__/ \__,_|___/

```

**The durable coordination fabric for AI agents and developer tools.**

At-least-once delivery with restart-durable retry (`delivery_attempts`), a dead-letter queue with
operator replay, emit-side idempotency, and disk-full recovery — no event is lost on a crash, a
restart, a full disk, or a missed push. Monthly tiered storage auto-splits at 10 GB and reads across
tiers transparently, so the hot working set stays small as history grows to millions of rows. Large
payloads go to a content-addressed store; causality/lineage tracing, a schema registry, and a
WB-0xx error taxonomy round it out.

Zero infrastructure: the durability substrate is **embedded SQLite (ACID/WAL)** — there's no server
to run, no network, and events stay on your machine. SQLite is the reason there's zero infra, not
the headline.

Built for agent ecosystems where multiple tools need to communicate without coupling to each other —
AI coding assistants, test runners, knowledge systems, deployment tools, or anything that benefits
from durable, event-driven coordination.

> **Status:** v2.3.0, published to npm as [`wicked-bus`](https://www.npmjs.com/package/wicked-bus)
> (also GitHub Packages as `@mikeparcewski/wicked-bus`). Pure JavaScript/ESM — no build step, no
> Rust. The v2 line is a layered coordination fabric where every layer is optional, with the v1
> `emit/poll/ack/register` API preserved unchanged.

> **Single-host today.** Push is over a local Unix socket (a push daemon layered on durable poll, so
> a missed push never loses an event); there is **no remote/TCP event delivery**. Scale is vertical
> and temporal — the hot set stays small as history tiers out — **not** horizontal or clustered.

**The differentiator:** restart-durable, at-least-once delivery with a dead-letter queue and operator
replay — a coordination fabric with real delivery guarantees that still needs zero infrastructure to
run.

wicked-bus is the **event substrate** of the [wicked-* family](https://wickedagile.com): a
local-first stack for AI coding agents anchored by [wicked-estate](https://github.com/mikeparcewski/wicked-estate)
(the code graph), with [wicked-core](https://github.com/mikeparcewski/wicked-core) (the runtime),
[wicked-brain](https://github.com/mikeparcewski/wicked-brain) (memory), and
[wicked-crew](https://github.com/mikeparcewski/wicked-crew) (the workflow governor that drives your
coding-agent CLIs as governed workers).

## Quick Start

### Install

```bash
npm install wicked-bus
```

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

```javascript
import { emit, poll, ack, register } from 'wicked-bus';
import { loadConfig } from 'wicked-bus/lib/config.js';
import { openDb } from 'wicked-bus/lib/db.js';

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
| `cleanup` | Run TTL sweep (delete expired events) |

All commands output structured JSON. Errors go to stderr with codes from the WB-0xx taxonomy (WB-001 through WB-013).

## AI CLI Skills

wicked-bus ships skills for AI coding assistants (Claude, Gemini, Copilot, Codex, Cursor).

### Install skills

```bash
npx wicked-bus-install
```

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

- **At-least-once delivery**: cursors persist across restarts and retry is restart-durable (`delivery_attempts`). Unacked events are re-delivered; events that exhaust retries land in a dead-letter queue you can inspect and replay. No lost events.
- **Durable, idempotent, crash-safe**: emit-side idempotency and disk-full recovery mean a crash, a restart, or a full disk never corrupts or duplicates the log.
- **Stays small as it grows**: monthly tiered storage auto-splits at 10 GB and reads across tiers transparently, so the hot working set stays fast at millions of rows. Two-timer TTL expires events automatically — no manual cleanup, no unbounded growth.
- **Zero infrastructure**: the substrate is a single embedded SQLite file (ACID/WAL). No servers to run, no ports to manage, no network — events stay on your machine.
- **Fire-and-forget**: producers are non-blocking. The bus never slows the caller. If it's not installed, callers degrade gracefully.
- **Agent-native**: designed for AI coding assistants and the tools around them. Ships with skills for Claude, Gemini, Copilot, Codex, and Cursor.

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
