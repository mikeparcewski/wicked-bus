# wicked-bus Integration Guide

A practical guide for plugin developers integrating with wicked-bus. This guide covers
availability detection, fire-and-forget patterns, registration, and graceful degradation.

---

## Table of Contents

1. [Checking if wicked-bus is Available](#1-checking-if-wicked-bus-is-available)
2. [Fire-and-Forget Pattern](#2-fire-and-forget-pattern)
3. [Registering as a Provider](#3-registering-as-a-provider)
4. [Registering as a Subscriber](#4-registering-as-a-subscriber)
5. [Polling for Events](#5-polling-for-events)
6. [Acknowledging Events](#6-acknowledging-events)
7. [Graceful Degradation](#7-graceful-degradation)
8. [Complete Integration Examples](#8-complete-integration-examples)

---

## 1. Checking if wicked-bus is Available

### Node.js (Dynamic Import)

Use a cached dynamic import to check for wicked-bus exactly once per process lifetime. Do not use
`require` or static `import` — this would cause import-time failures when wicked-bus is not installed.

```javascript
let _wickedBusEmit = null;
let _wickedBusChecked = false;

async function _loadWickedBus() {
  if (_wickedBusChecked) return _wickedBusEmit;
  _wickedBusChecked = true;
  try {
    const mod = await import('wicked-bus');
    _wickedBusEmit = mod.emit;
  } catch (_) {
    // wicked-bus not installed — will degrade gracefully
    _wickedBusEmit = null;
  }
  return _wickedBusEmit;
}
```

**Why `_wickedBusChecked`?** Dynamic `import()` is attempted once. If wicked-bus is not installed,
the check is memoized as `null` — no repeated failed imports on every event emission.

### Python (subprocess availability check)

Python integrations use the `wicked-bus` CLI via subprocess. A pre-flight check is optional but
useful for logging:

```python
import shutil

def is_wicked_bus_available() -> bool:
    """Returns True if the wicked-bus CLI is on PATH."""
    return shutil.which("wicked-bus") is not None
```

For fire-and-forget integrations, skip the pre-flight check entirely and let the subprocess fail
silently (the exception is caught and logged at debug level).

---

## 2. Fire-and-Forget Pattern

wicked-bus integrations must **never block the calling plugin**. All event emissions are
fire-and-forget with bounded timeouts.

### Node.js: 50ms timeout

Use `Promise.race` between the actual emit and a 50ms timeout resolver:

```javascript
function emitEventFireAndForget(eventType, payload) {
  Promise.race([
    _loadWickedBus().then(emit => {
      if (!emit) return; // not installed
      return emit({
        event_type: eventType,
        domain: 'my-plugin',
        payload,
      });
    }),
    new Promise(resolve => setTimeout(resolve, 50)), // 50ms hard ceiling
  ]).catch(err => {
    // Single debug log — never rethrow
    if (process.env.DEBUG?.includes('wicked-bus')) {
      process.stderr.write(
        `[wicked-bus] event dropped: ${eventType} — ${err.message}\n`
      );
    }
  });
  // Returns synchronously — caller is not blocked
}
```

The `Promise.race` wins on whichever resolves first: either the bus write completes within 50ms,
or the timeout fires. Either way, the calling function returns immediately.

### Python: 100ms timeout via daemon thread

```python
import subprocess
import threading
import json

def emit_event_fire_and_forget(event_type: str, payload: dict,
                                source_plugin: str = 'my-plugin') -> None:
    """Fire-and-forget. Never raises. Returns immediately."""
    payload_str = json.dumps(payload)

    def _emit():
        try:
            subprocess.run(
                [
                    'wicked-bus', 'emit',
                    '--type', event_type,
                    '--domain', source_plugin,
                    '--payload', payload_str,
                ],
                timeout=0.1,        # 100ms hard limit
                capture_output=True,
                check=False,        # Non-zero exit is silently ignored
            )
        except Exception as exc:
            # Swallow all exceptions — plugin must not fail due to bus
            import logging
            logging.getLogger('wicked-bus').debug(
                '[wicked-bus] not available, event dropped: %s — %s', event_type, exc
            )

    # Daemon thread: automatically cleaned up when the process exits
    threading.Thread(target=_emit, daemon=True).start()
    # Do NOT .join() — caller returns immediately
```

**Why daemon thread?** A daemon thread does not prevent the Python process from exiting. The
thread's lifecycle is tied to the main process — no risk of hanging on process shutdown.

---

## 3. Registering as a Provider

Providers declare which event types they will emit. Registration is optional in v1 (you can emit
events without being registered), but it enables discovery via `wicked-bus list` and provides
documentation for the event catalog.

### CLI registration

```bash
wicked-bus register \
  --role provider \
  --domain my-plugin \
  --events "wicked.task.completed,wicked.task.failed" \
  --schema-version 1.0.0
```

Save the returned `subscription_id` if you need to deregister later.

### Programmatic registration (Node.js)

```javascript
import { register } from 'wicked-bus';

const result = await register({
  role: 'provider',
  domain: 'my-plugin',
  events: ['wicked.task.completed', 'wicked.task.failed'],
  schemaVersion: '1.0.0',
});

console.log(result.subscription_id); // save for deregistration
```

### Provider manifest sidecar

On registration, wicked-bus writes a JSON manifest to:
```
~/.something-wicked/wicked-bus/providers/<plugin-name>.json
```

This file is informational — the authoritative record is the `subscriptions` table row.

### Event type naming convention

All event types must follow the four-segment pattern:
```
wicked.<domain>.<noun>.<past-tense-verb>
```

Examples:
- `wicked.test.run.completed`
- `wicked.crew.phase.started`
- `wicked.brain.memory.stored`

Do not use three-segment names (e.g. `wicked.myapp.done`) — they will conflict with wildcard
filter semantics in future versions.

---

## 4. Registering as a Subscriber

Subscribers declare a filter pattern and a cursor initialization mode.

### CLI registration

```bash
# Subscribe to all test run events from any domain (single-level wildcard)
wicked-bus register \
  --role subscriber \
  --domain my-consumer \
  --filter 'wicked.run.*' \
  --cursor-init latest

# Subscribe to test run events from wicked-testing only
wicked-bus register \
  --role subscriber \
  --domain my-consumer \
  --filter 'wicked.run.*@wicked-testing' \
  --cursor-init latest
```

**Response**:
```json
{
  "subscription_id": "b2c3d4e5-...",
  "cursor_id": "c3d4e5f6-...",
  "last_event_id": 99,
  "registered_at": 1744393800000
}
```

Save both `subscription_id` and `cursor_id` for subsequent poll and ack calls.

### Filter pattern reference

| Pattern | Matches | Does Not Match |
|---------|---------|----------------|
| `wicked.run.completed` | Exact type, any domain | `wicked.run.started` |
| `wicked.run.*` | All run lifecycle events from **any** domain | `wicked.phase.started` |
| `wicked.run.*@wicked-testing` | Run events from `wicked-testing` only | Run events from other domains |
| `wicked.phase.*` | All phase events from any domain | `wicked.project.created` |
| `wicked.memory.*@wicked-brain` | Brain memory events only | Memory events from other domains |
| `*@wicked-garden` | Every event emitted by `wicked-garden` | Events from other domains |

**Important**: event types are now **three-segment** (`wicked.<noun>.<verb>`). The `@<domain>`
suffix is optional and scopes the filter to a specific publisher. Without `@`, the filter matches
any domain that emits the event type.

**`wicked.*`** does **NOT** work as a "match everything" wildcard — the wildcard is single-level.
Use `*@wicked-garden` to match all events from a specific domain.

### Cursor initialization modes

| Mode | Description | Use when |
|------|-------------|----------|
| `latest` | Only receive events emitted after registration | First-time setup; you don't need historical events |
| `oldest` | Receive all non-expired events from the beginning of the log | Backfill; you want to process everything |

---

## 5. Polling for Events

### CLI poll loop

```bash
# Enter polling loop (NDJSON output, Ctrl-C to exit)
wicked-bus subscribe \
  --domain my-consumer \
  --filter 'wicked.run.*@wicked-testing' \
  --cursor-id c3d4e5f6-...
```

Each event is printed as a JSON object on its own line (NDJSON format):
```
{"event_id":42,"event_type":"wicked.test.run.completed","source_plugin":"wicked-testing","payload":{...},...}
{"event_id":43,"event_type":"wicked.test.run.failed","source_plugin":"wicked-testing","payload":{...},...}
```

### Programmatic poll (Node.js)

```javascript
import { poll, ack } from 'wicked-bus';

const cursorId = 'c3d4e5f6-...';
const processed = new Map(); // idempotency_key → true

async function processLoop() {
  while (true) {
    const events = await poll(cursorId, { batchSize: 100 });

    for (const event of events) {
      // Deduplication: skip if already processed
      if (processed.has(event.idempotency_key)) continue;

      await handleEvent(event);
      processed.set(event.idempotency_key, true);

      // Acknowledge after each successful event
      await ack(cursorId, event.event_id);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

**Use an LRU cache instead of a Map** for long-running subscribers to avoid unbounded memory growth.
Set the LRU max age to `dedup_ttl_hours` (default 24h) — keys older than this have been swept from
the event log and cannot be re-delivered.

### Batch processing pattern

```javascript
for (const event of events) {
  if (processed.has(event.idempotency_key)) continue;
  await handleEvent(event);
  processed.set(event.idempotency_key, true);
}

// Ack the entire batch at the highest event_id
if (events.length > 0) {
  const lastEventId = events[events.length - 1].event_id;
  await ack(cursorId, lastEventId);
}
```

This reduces ack calls but increases the re-delivery window on crash: if you crash after processing
event 50 but before acking, events 1–50 are all re-delivered on restart.

---

## 6. Acknowledging Events

Acknowledgment is explicit and mandatory. wicked-bus never auto-advances the cursor.

### CLI ack

```bash
wicked-bus ack --cursor-id c3d4e5f6-... --last-event-id 42
```

**Response**:
```json
{"acked": true, "cursor_id": "c3d4e5f6-...", "last_event_id": 42}
```

The ack is a single atomic SQLite transaction. On success, subsequent polls start from `event_id = 43`.

### What happens if you skip acking?

If your subscriber crashes before acking, the cursor retains the last acked `last_event_id`. On
restart, all unacked events are re-delivered. This is the at-least-once guarantee — your handler
**must** be idempotent or use `idempotency_key` to deduplicate.

---

## 7. Graceful Degradation

All wicked-bus integrations must degrade gracefully when the bus is unavailable. "Unavailable" means:
- `wicked-bus` is not installed (not in `node_modules` or not on PATH)
- The data directory does not exist
- The DB is locked or corrupt
- The disk is full (WB-004)

### Node.js degradation checklist

- [ ] Use dynamic `import('wicked-bus')` (not static import)
- [ ] Cache the import result with a boolean flag (`_wickedBusChecked`)
- [ ] Wrap all emit calls in `Promise.race` with a 50ms timeout
- [ ] Catch all Promise rejections; never rethrow
- [ ] Log only at debug level (guard with `process.env.DEBUG?.includes('wicked-bus')`)
- [ ] Never let bus unavailability cause a test failure or thrown error

### Python degradation checklist

- [ ] Use a daemon thread for subprocess calls
- [ ] Set `timeout=0.1` (100ms) on `subprocess.run`
- [ ] Set `check=False` so non-zero exit does not raise
- [ ] Wrap the entire `_emit` function body in `try/except Exception`
- [ ] Log at `debug` level (not `error` or `warning`) for expected unavailability (AC-23, AC-30)
- [ ] Log at `warning` level for unexpected failures (AC-25) — for wicked-garden where wicked-bus
  was expected but failed mid-operation

### Degradation log messages

| Scenario | Level | Message |
|----------|-------|---------|
| wicked-bus not installed (Node.js) | debug | `[wicked-bus] not available, event dropped: <event_type> — Cannot find module 'wicked-bus'` |
| wicked-bus not installed (Python) | debug | `[wicked-bus] not available, knowledge event dropped: <event_type> — <exc>` |
| wicked-bus unavailable mid-operation (wicked-garden) | warning | `[wicked-bus] emit failed, event dropped: <event_type> — <exc>` |

---

## 8. Complete Integration Examples

### Example A: Node.js plugin emitting domain events

```javascript
// my-plugin/lib/event-emitter.mjs

let _emit = null;
let _checked = false;

async function _load() {
  if (_checked) return _emit;
  _checked = true;
  try {
    const mod = await import('wicked-bus');
    _emit = mod.emit;
  } catch (_) {
    _emit = null;
  }
  return _emit;
}

const EVENT_MAP = {
  'task.completed': 'wicked.task.completed',
  'task.failed':    'wicked.task.failed',
};

export function emitDomainEvent(action, id, payload) {
  const eventType = EVENT_MAP[action];
  if (!eventType) throw new Error(`Unknown action: ${action}. Add it to EVENT_MAP.`);

  Promise.race([
    _load().then(emit => {
      if (!emit) return;
      return emit({
        event_type: eventType,
        domain: 'my-plugin',
        payload: { id, ...payload },
      });
    }),
    new Promise(resolve => setTimeout(resolve, 50)),
  ]).catch(err => {
    if (process.env.DEBUG?.includes('wicked-bus')) {
      process.stderr.write(`[wicked-bus] event dropped: ${eventType} — ${err.message}\n`);
    }
  });
}
```

Usage:
```javascript
import { emitDomainEvent } from './event-emitter.mjs';

// In your task completion handler:
emitDomainEvent('task.completed', task.id, { status: 'done', duration_ms: 840 });
// Returns immediately — non-blocking
```

### Example B: Python plugin emitting events via CLI

```python
# my_plugin/events.py

import subprocess
import threading
import json
import logging

logger = logging.getLogger('my-plugin')

EVENT_MAP = {
    'task_completed': 'wicked.task.completed',
    'task_failed':    'wicked.task.failed',
}

def emit_domain_event(action: str, entity_id: str, payload: dict) -> None:
    """Fire-and-forget. Never raises. Returns immediately."""
    event_type = EVENT_MAP.get(action)
    if not event_type:
        raise ValueError(f'Unknown action: {action}. Add it to EVENT_MAP.')
    full_payload = {'id': entity_id, **payload}

    def _do_emit():
        try:
            subprocess.run(
                ['wicked-bus', 'emit',
                 '--type', event_type,
                 '--domain', 'my-plugin',
                 '--payload', json.dumps(full_payload)],
                timeout=0.1,
                capture_output=True,
                check=False,
            )
        except Exception as exc:
            logger.debug('[wicked-bus] event dropped: %s — %s', event_type, exc)

    threading.Thread(target=_do_emit, daemon=True).start()
```

Usage:
```python
from .events import emit_domain_event

# In your task completion handler:
emit_domain_event('task_completed', task.id, {'status': 'done', 'duration_ms': 840})
# Returns immediately — non-blocking
```

### Example C: Subscribing to wicked-testing events

```javascript
// consumer/index.mjs — watch for test run completions

import { register, poll, ack } from 'wicked-bus';

const { cursor_id: cursorId } = await register({
  role: 'subscriber',
  domain: 'my-consumer',
  filter: 'wicked.run.*@wicked-testing',  // all run events from wicked-testing
  cursorInit: 'latest',
});

console.log(`Registered. Cursor: ${cursorId}`);

const seen = new Set();

async function runLoop() {
  while (true) {
    try {
      const events = await poll(cursorId, { batchSize: 50 });

      for (const event of events) {
        if (seen.has(event.idempotency_key)) continue;

        console.log(`[${event.event_type}] run=${event.payload.runId} status=${event.payload.status}`);
        seen.add(event.idempotency_key);
        await ack(cursorId, event.event_id);
      }
    } catch (err) {
      if (err.code === 'WB-003') {
        console.error('Cursor behind TTL window. Resetting to oldest available.');
        // Use wicked-bus replay CLI or programmatic API to reset
        break;
      }
      console.error('Poll error:', err.message);
    }

    await new Promise(r => setTimeout(r, 1000));
  }
}

runLoop().catch(console.error);
```

### Example D: wicked-brain knowledge event emission (Python)

wicked-brain emits knowledge events when it stores a new memory chunk or updates its index. The pattern mirrors the Python subprocess approach, with `chunk_id` and `tier` in the payload. Note: for `knowledge.updated` events the `chunk_id` may be empty (index-level change, not a specific chunk).

```python
import subprocess, json, logging, shutil, threading

_logger = logging.getLogger("wicked-brain")
_WICKED_BUS = shutil.which("wicked-bus")

def _emit_knowledge_event(event_type: str, chunk_id: str, tier: str, tags: list[str]) -> None:
    """Fire-and-forget — never raises. Returns immediately."""
    if not _WICKED_BUS:
        _logger.debug("[wicked-bus] not available, event dropped: %s", event_type)
        return
    # JSON payload uses camelCase keys per the wicked-bus event catalog (F-003)
    payload = json.dumps({"chunkId": chunk_id, "tier": tier, "tags": tags})

    def _do_emit() -> None:
        try:
            subprocess.run(
                [_WICKED_BUS, "emit",
                 "--type", event_type,
                 "--domain", "wicked-brain",
                 "--subdomain", "brain.memory",
                 "--payload", payload],
                timeout=0.1,           # 100ms hard timeout
                capture_output=True,
                check=False,
            )
        except Exception as exc:
            _logger.debug("[wicked-bus] emit failed for %s: %s", event_type, exc)

    # Daemon thread: caller returns immediately; thread cleaned up on process exit (F-004)
    threading.Thread(target=_do_emit, daemon=True).start()

# Usage when storing a memory chunk:
_emit_knowledge_event(
    event_type="wicked.memory.stored",
    chunk_id="mem-abc123",
    tier="semantic",
    tags=["crew", "pattern"],
)

# Usage when updating the knowledge index (no specific chunk):
_emit_knowledge_event(
    event_type="wicked.knowledge.updated",
    chunk_id="",          # empty — index-level update
    tier="",
    tags=[],
)
```

**Graceful degradation (AC-30)**: if `wicked-bus` is not on PATH, `shutil.which` returns `None`, the guard returns immediately, and wicked-brain continues without error.

---

### Example E: Replaying missed events

```bash
# Subscriber missed events due to downtime. Reset cursor to replay from event 500.
wicked-bus replay \
  --cursor-id c3d4e5f6-... \
  --from-event-id 500

# Check what's available
wicked-bus status --json | jq '.oldest_event_id, .newest_event_id'

# If cursor is behind TTL, replay from oldest available
OLDEST=$(wicked-bus status --json | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.parse(d).oldest_event_id)")
wicked-bus replay --cursor-id c3d4e5f6-... --from-event-id $OLDEST
```

---

## Appendix: AC Cross-Reference

| AC | Topic | Section |
|----|-------|---------|
| AC-22 | wicked-testing `_emitEvent` integration; 50ms timeout | Section 2 |
| AC-23 | wicked-testing graceful degradation | Section 7 |
| AC-24 | wicked-garden `phase_manager` hooks; 100ms timeout | Section 2 |
| AC-25 | wicked-garden graceful degradation | Section 7 |
| AC-29 | wicked-brain knowledge events | Section 2, Example D |
| AC-30 | wicked-brain graceful degradation | Section 7, Example D |
| AC-5  | Provider registration | Section 3 |
| AC-6  | Subscriber registration; filter semantics | Section 4 |
| AC-7  | Cursor persistence; ack protocol | Section 6 |
| AC-8  | At-least-once on restart | Section 5, 6 |
| AC-14 | CLI subscribe; NDJSON stream | Section 5 |
