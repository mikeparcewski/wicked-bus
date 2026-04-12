```
 ██╗    ██╗██╗ ██████╗██╗  ██╗███████╗██████╗     ██████╗ ██╗   ██╗███████╗
 ██║    ██║██║██╔════╝██║ ██╔╝██╔════╝██╔══██╗    ██╔══██╗██║   ██║██╔════╝
 ██║ █╗ ██║██║██║     █████╔╝ █████╗  ██║  ██║    ██████╔╝██║   ██║███████╗
 ██║███╗██║██║██║     ██╔═██╗ ██╔══╝  ██║  ██║    ██╔══██╗██║   ██║╚════██║
 ╚███╔███╔╝██║╚██████╗██║  ██╗███████╗██████╔╝    ██████╔╝╚██████╔╝███████║
  ╚══╝╚══╝ ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═════╝     ╚═════╝  ╚═════╝ ╚══════╝
```

A lightweight, local-first event bus for AI agents and developer tools.

SQLite-backed, single-host, poll-based delivery with at-least-once semantics. No servers, no network transport, no infrastructure. Events stay on your machine.

Built for agent ecosystems where multiple tools need to communicate without coupling to each other — AI coding assistants, test runners, knowledge systems, deployment tools, or anything that benefits from local event-driven architecture.

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
  --type wicked.task.completed \
  --domain my-plugin \
  --payload '{"taskId": "abc", "status": "done"}'
```

### Subscribe to events

```bash
wicked-bus subscribe --filter 'wicked.task.*'
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
  event_type: 'wicked.deploy.completed',
  domain: 'my-deploy',
  subdomain: 'deploy.production',
  payload: { version: '2.0.0' },
});

// Subscribe
const sub = register(db, {
  plugin: 'my-consumer',
  role: 'subscriber',
  event_type_filter: 'wicked.deploy.*',
  cursor_init: 'latest',
});

// Poll
const events = poll(db, config, {
  cursor_id: sub.cursor_id,
  filter: 'wicked.deploy.*',
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

All commands output structured JSON. Errors go to stderr with error codes (WB-001 through WB-006).

## AI CLI Skills

wicked-bus ships skills for AI coding assistants (Claude, Gemini, Copilot, Codex, Cursor).

### Install skills

```bash
npx wicked-bus-install
```

Auto-detects installed CLIs and copies skills. Available skills:

| Skill | Purpose |
|-------|---------|
| `wicked-bus/init` | Initialize or connect to the bus |
| `wicked-bus/emit` | Publish events |
| `wicked-bus/subscribe` | Consume events |
| `wicked-bus/naming` | Event naming conventions |
| `wicked-bus/query` | Query and debug |
| `wicked-bus/status` | Bus health and diagnostics |
| `wicked-bus/update` | Check for and install updates |

## Why wicked-bus?

Agent ecosystems have a communication problem. Tools that should work together — test runners, code reviewers, knowledge systems, deployment pipelines — end up tightly coupled or completely siloed. wicked-bus solves this with a dead-simple local event bridge.

- **Local-first**: everything lives in a single SQLite file. No servers to run, no ports to manage, no infrastructure.
- **At-least-once delivery**: cursors persist across restarts. Unacked events are re-delivered. No lost events.
- **Fire-and-forget**: producers are non-blocking. The bus never slows the caller. If it's not installed, callers degrade gracefully.
- **Agent-native**: designed for AI coding assistants and the tools around them. Ships with skills for Claude, Gemini, Copilot, Codex, and Cursor.
- **Two-timer TTL**: events auto-expire. No manual cleanup, no unbounded growth.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) -- system design and module structure
- [USERS_GUIDE.md](./USERS_GUIDE.md) -- event naming, payload conventions, integration patterns
- [reqs/SPEC.md](./reqs/SPEC.md) -- full specification

## Requirements

- Node.js >= 18.0.0
- `better-sqlite3` >= 9.0.0 (peer dependency)
- macOS, Linux, or Windows

## License

MIT
