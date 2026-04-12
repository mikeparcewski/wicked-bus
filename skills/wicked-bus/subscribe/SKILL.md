---
name: wicked-bus:subscribe
description: Subscribe to wicked-bus events. Use when consuming events from the bus, setting up event listeners, polling for new events, or integrating as a subscriber. Covers registration, polling, acknowledgment, and filter patterns.
---

# wicked-bus:subscribe

Guide for consuming events from the wicked-bus.

## When to use

- User wants to listen for events
- User asks "how do I subscribe to the bus" or "how do I consume events"
- Setting up a new subscriber integration
- User needs help with filter patterns

## Prerequisites

Check that wicked-bus is initialized. If not, trigger `wicked-bus-init`.

## CLI Usage (quickest way to start)

### Subscribe to events (streaming)

```bash
# All run events from any source
npx wicked-bus subscribe --filter 'wicked.run.*'

# Only from a specific domain
npx wicked-bus subscribe --filter 'wicked.run.*@wicked-testing'

# Everything from a domain
npx wicked-bus subscribe --filter '*@wicked-brain'

# Without auto-acknowledgment
npx wicked-bus subscribe --filter 'wicked.phase.*' --no-ack
```

Output is NDJSON — one JSON object per line per event.

### Register then poll manually

```bash
# Register as subscriber
npx wicked-bus register \
  --role subscriber \
  --plugin my-consumer \
  --filter 'wicked.run.*' \
  --cursor-init latest

# Poll (uses cursor from registration)
npx wicked-bus subscribe --plugin my-consumer --filter 'wicked.run.*'

# Manual ack
npx wicked-bus ack --cursor-id {cursor_id} --event-id {event_id}
```

## Programmatic Usage (Node.js)

### Basic poll loop

```javascript
import { poll, ack } from 'wicked-bus';
import { loadConfig } from 'wicked-bus/lib/config.js';
import { openDb } from 'wicked-bus/lib/db.js';
import { register } from 'wicked-bus/lib/register.js';

const config = loadConfig();
const db = openDb(config);

// Register (idempotent — safe to call on every startup)
const sub = register(db, {
  plugin: 'my-consumer',
  role: 'subscriber',
  event_type_filter: 'wicked.run.*',
  cursor_init: 'latest',
});

// Poll for new events
const events = poll(db, config, {
  cursor_id: sub.cursor_id,
  filter: 'wicked.run.*',
  batch_size: 10,
});

for (const event of events.events) {
  console.log(event.event_type, event.payload);
  // Process the event...
}

// Acknowledge (advances the cursor)
if (events.events.length > 0) {
  const lastId = events.events[events.events.length - 1].event_id;
  ack(db, { cursor_id: sub.cursor_id, event_id: lastId });
}

db.close();
```

### Fire-and-forget subscriber (for integrations)

Plugins that react to bus events but should never block:

```javascript
async function checkBusEvents() {
  try {
    const { poll, ack } = await import('wicked-bus');
    const { loadConfig } = await import('wicked-bus/lib/config.js');
    const { openDb } = await import('wicked-bus/lib/db.js');

    const config = loadConfig();
    const db = openDb(config);

    const result = poll(db, config, {
      cursor_id: myCursorId,
      filter: 'wicked.phase.*@wicked-garden',
      batch_size: 50,
    });

    for (const event of result.events) {
      // React to the event (non-blocking)
    }

    if (result.events.length > 0) {
      const lastId = result.events[result.events.length - 1].event_id;
      ack(db, { cursor_id: myCursorId, event_id: lastId });
    }

    db.close();
  } catch (_) {
    // Bus unavailable — degrade gracefully
  }
}
```

## Filter Patterns

| Pattern | Matches |
|---------|---------|
| `wicked.run.completed` | Exact match only |
| `wicked.run.*` | All `wicked.run.` events (single-level wildcard) |
| `*@wicked-brain` | All events from the `wicked-brain` domain |
| `wicked.memory.*@wicked-brain` | Memory events from brain only |

### Filter rules

1. `*` matches exactly one segment (single-level wildcard)
2. `@domain` suffix scopes by the `domain` column
3. Wildcards and `@domain` can combine: `wicked.run.*@my-plugin`
4. `*` alone (catch-all) is valid but noisy

## Delivery Semantics

- **At-least-once**: unacked events are re-delivered on next poll
- **Cursor-based**: each subscriber has its own cursor position
- **Batch polling**: use `batch_size` to control how many events per poll
- **Visibility filter**: events past `expires_at` are invisible to poll
- **WB-003 warning**: if your cursor is behind the oldest event, you may have missed events

## Error Handling

| Error | Code | Meaning |
|-------|------|---------|
| WB-003 | CURSOR_BEHIND | Cursor is behind oldest available event — events may have been missed |
| WB-006 | CURSOR_NOT_FOUND | Cursor ID doesn't exist or was deregistered |
