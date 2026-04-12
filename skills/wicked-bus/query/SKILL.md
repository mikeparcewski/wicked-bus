---
name: wicked-bus:query
description: Query and debug the wicked-bus. Use when checking bus health, inspecting events, debugging delivery issues, tracing event flow, or investigating why a subscriber isn't receiving events. Covers status, replay, and direct SQLite queries.
---

# wicked-bus:query

Tools for inspecting, debugging, and querying the wicked-bus.

## When to use

- User asks "what's in the bus" or "show me recent events"
- Debugging why a subscriber isn't receiving events
- Checking bus health or event counts
- Investigating delivery lag or missed events
- User asks about cursor positions or subscriber state

## Quick Health Check

```bash
npx wicked-bus status
```

Returns JSON with:
- Total event count
- Active subscriber count
- Provider list
- Cursor lag per subscriber

## Inspecting Events

### Recent events via SQLite

```bash
# Last 10 events
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT event_id, event_type, domain, subdomain, datetime(emitted_at/1000, 'unixepoch') as time FROM events ORDER BY event_id DESC LIMIT 10;"
```

### Events by type

```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT event_id, domain, subdomain, datetime(emitted_at/1000, 'unixepoch') as time FROM events WHERE event_type = 'wicked.phase.completed' ORDER BY event_id DESC LIMIT 10;"
```

### Events by domain

```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT event_id, event_type, subdomain, datetime(emitted_at/1000, 'unixepoch') as time FROM events WHERE domain = 'wicked-garden' ORDER BY event_id DESC LIMIT 10;"
```

### Event count by type

```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC;"
```

### Full event payload

```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT event_id, event_type, domain, payload FROM events WHERE event_id = {id};"
```

## Debugging Subscribers

### Check cursor positions

```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT c.cursor_id, s.plugin, s.event_type_filter, c.last_event_id, datetime(c.acked_at/1000, 'unixepoch') as last_ack FROM cursors c JOIN subscriptions s ON c.subscription_id = s.subscription_id WHERE c.deregistered_at IS NULL;"
```

### Find subscriber lag

```bash
# Compare cursor position to latest event
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT s.plugin, c.last_event_id, (SELECT MAX(event_id) FROM events) - c.last_event_id as lag FROM cursors c JOIN subscriptions s ON c.subscription_id = s.subscription_id WHERE c.deregistered_at IS NULL;"
```

### Check if subscriber is registered

```bash
npx wicked-bus list --role subscriber --json
```

### Check active vs deregistered

```bash
npx wicked-bus list --include-deregistered --json
```

## Common Issues

### "Subscriber isn't receiving events"

1. **Check registration**: `npx wicked-bus list --role subscriber`
2. **Check filter**: does the filter match the event_type?
   - `wicked.run.*` matches `wicked.run.completed` but NOT `wicked.run.step.completed`
   - `@domain` suffix must match the `domain` column exactly
3. **Check cursor position**: is the cursor ahead of the events?
4. **Check expiry**: events past `expires_at` (default 72h) are invisible
5. **Check deregistration**: was the subscription soft-deleted?

### "WB-003: Cursor behind oldest event"

The subscriber's cursor is behind the oldest event in the table. Events
between the cursor and the oldest event were swept (deleted after
`dedup_expires_at`). These events are permanently lost for this subscriber.

**Fix**: Reset the cursor to the current position:
```bash
npx wicked-bus replay --cursor-id {cursor_id} --event-id {latest_event_id}
```

### "Events seem to disappear"

Events are deleted by the sweep process after `dedup_expires_at` (default 24h).
Check your sweep configuration:

```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT * FROM schema_migrations;"
```

Check config:
```bash
cat ~/.something-wicked/wicked-bus/config.json
```

### "Duplicate events"

Events have a UNIQUE `idempotency_key`. If you're seeing duplicates, the
emitter is generating different keys for logically identical events. Fix
by using a deterministic key:

```javascript
emit(db, config, {
  event_type: 'wicked.job.completed',
  domain: 'my-plugin',
  payload: { jobId: 'job-42' },
  idempotency_key: `job-42-completed`, // Deterministic
});
```

## Cleanup and Maintenance

### Manual sweep

```bash
# Dry run — see what would be deleted
npx wicked-bus cleanup --dry-run

# Delete expired events
npx wicked-bus cleanup

# Delete and archive to events_archive table
npx wicked-bus cleanup --archive
```

### Check database size

```bash
ls -lh ~/.something-wicked/wicked-bus/bus.db
```

### Check WAL size

```bash
ls -lh ~/.something-wicked/wicked-bus/bus.db-wal
```

Large WAL files indicate checkpointing isn't happening. This is normal
for busy periods — SQLite auto-checkpoints at 1000 pages.
