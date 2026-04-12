```
 ██╗    ██╗██╗ ██████╗██╗  ██╗███████╗██████╗
 ██║    ██║██║██╔════╝██║ ██╔╝██╔════╝██╔══██╗
 ██║ █╗ ██║██║██║     █████╔╝ █████╗  ██║  ██║
 ██║███╗██║██║██║     ██╔═██╗ ██╔══╝  ██║  ██║
 ╚███╔███╔╝██║╚██████╗██║  ██╗███████╗██████╔╝
  ╚══╝╚══╝ ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═════╝
            ____  __  ______
           / __ )/ / / / __/
          / __  / / / /\ \
         /____/_/\___/___/
```

A lightweight, local-first event bridge for the wicked-\* ecosystem.

SQLite-backed, single-host, poll-based delivery with at-least-once semantics. No network transport, no external dependencies beyond SQLite. Events stay on your machine.

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

## Key Concepts

- **Local-first**: everything lives in `~/.something-wicked/wicked-bus/bus.db`. No network, no servers.
- **At-least-once delivery**: cursors persist across restarts. Unacked events are re-delivered.
- **Fire-and-forget**: integrations are non-blocking. The bus never slows the caller.
- **Graceful degradation**: if the bus isn't installed, callers log a debug message and continue.
- **Two-timer TTL**: events have `dedup_expires_at` (24h default, row deletion) and `expires_at` (72h default, visibility filter).

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
