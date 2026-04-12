# User's Guide

A practical guide for integrating with wicked-bus. Covers how to name events, structure payloads, and connect your tools and agents to the bus.

## How Events Work

Every event in wicked-bus has three identity fields and a payload:

```
┌─────────────────────────────────────────────────────┐
│  event_type: wicked.deployment.completed            │  ← What happened
│  domain:     my-deploy-tool                         │  ← Who did it
│  subdomain:  deploy.production                      │  ← Where in the system
│  payload:    { version: "2.0.0", duration_ms: 450 } │  ← The details
└─────────────────────────────────────────────────────┘
```

**event_type** is semantic -- it describes what happened, not who did it. Two different plugins can emit the same event_type if they represent the same kind of thing happening.

**domain** is your plugin's package name. It identifies the publisher.

**subdomain** is the functional area within your plugin. It's dot-separated and can be as deep as you need.

## Event Type Naming

### The Pattern

```
wicked.<noun>.<past-tense-verb>
```

Three segments. Always starts with `wicked.`. The noun is the thing that changed. The verb is past tense -- what already happened.

### Examples

| Event Type | What It Means |
|------------|--------------|
| `wicked.deployment.completed` | A deployment finished |
| `wicked.deployment.started` | A deployment began |
| `wicked.deployment.failed` | A deployment failed |
| `wicked.task.created` | A task was created |
| `wicked.cache.invalidated` | A cache was cleared |
| `wicked.build.completed` | A build finished |
| `wicked.report.generated` | A report was produced |

### Common Verbs

Use these consistently:

| Verb | When |
|------|------|
| `created` | A new thing came into existence |
| `updated` | An existing thing was modified |
| `deleted` | A thing was removed |
| `started` | A process began |
| `completed` | A process finished successfully |
| `failed` | A process finished with errors |
| `stored` | Data was persisted |
| `expired` | A thing timed out or aged out |

### Mistakes to Avoid

| Wrong | Why | Correct |
|-------|-----|---------|
| `my-plugin.task.completed` | Domain in the type | `wicked.task.completed` + domain=`my-plugin` |
| `wicked.task.complete` | Not past tense | `wicked.task.completed` |
| `wicked.my.task.completed` | Four segments | `wicked.task.completed` + subdomain for context |
| `task.completed` | Missing `wicked.` prefix | `wicked.task.completed` |
| `wicked.taskCompleted` | camelCase | `wicked.task.completed` |

## Choosing Your Domain

Your domain is your package name. That's it.

If your npm package is `my-deploy-tool`, your domain is `my-deploy-tool`. If it's `acme-ci`, your domain is `acme-ci`.

Rules:
- One domain per plugin
- Max 64 characters
- Lowercase, hyphens are fine
- This is what subscribers use in `@domain` filters

## Choosing Your Subdomain

The subdomain identifies where within your system the event came from. Use `<area>.<entity>` format.

| Plugin | Subdomain | Meaning |
|--------|-----------|---------|
| A deploy tool | `deploy.staging` | Staging deployment subsystem |
| A deploy tool | `deploy.production` | Production deployment subsystem |
| A CI system | `build.artifact` | Build artifact pipeline |
| A CI system | `test.unit` | Unit test runner |
| An auth service | `auth.session` | Session management |

Rules:
- Dot-separated hierarchy
- Max 64 characters
- Defaults to empty string if not relevant
- Can be as deep as needed: `area.entity.detail`

## Payload Conventions

The payload is a JSON object. There are no enforced schema rules beyond "must be valid JSON object," but following these conventions makes events useful to consumers.

### Always Include

- **An identifier**: whatever uniquely identifies the thing that changed (`taskId`, `deployId`, `buildId`)
- **Status or outcome**: if the event represents completion, include the result (`status: "passed"`, `verdict: "approved"`)

### Include When Relevant

- **Duration**: if the event represents something that took time, include `duration_ms`
- **Counts**: if the event summarizes work, include counts (`fileCount`, `errorCount`)
- **Reason**: if something failed or was skipped, include `reason`

### Keep It Small

The default max payload size is 1 MB. In practice, keep payloads under 10 KB. Payloads are stored as JSON text in SQLite -- large payloads slow down queries.

Don't put file contents in payloads. Put a path or reference instead.

### Examples

**A deployment completed:**
```json
{
  "deployId": "deploy-42",
  "version": "2.0.0",
  "environment": "production",
  "duration_ms": 45000,
  "status": "success"
}
```

**A test run failed:**
```json
{
  "runId": "run-abc",
  "projectId": "proj-1",
  "status": "failed",
  "error": "Assertion failed: expected 200, got 500",
  "duration_ms": 1200
}
```

**A cache was invalidated:**
```json
{
  "keys": ["user:123", "user:456"],
  "reason": "schema migration",
  "invalidatedCount": 2
}
```

**A report was generated:**
```json
{
  "reportId": "rpt-99",
  "type": "weekly-summary",
  "format": "pdf",
  "outputPath": "/reports/2026/week-15.pdf"
}
```

## Metadata

Events have an optional `metadata` field separate from the payload. Use it for operational context that isn't part of the event's business meaning:

```json
{
  "host": "prod-01",
  "pid": 12345,
  "git_sha": "abc123f"
}
```

Metadata is nullable and not indexed. Don't put anything in metadata that subscribers need to filter on.

## Subscribing to Events

### Filter Patterns

| Pattern | What It Matches |
|---------|----------------|
| `wicked.task.completed` | Exactly that event type |
| `wicked.task.*` | All task events (`created`, `completed`, `failed`, etc.) |
| `*@my-plugin` | Everything from `my-plugin` |
| `wicked.task.*@my-plugin` | Task events from `my-plugin` only |

The `*` wildcard matches exactly one segment. There's no multi-level wildcard (`**`) in v1.

### Delivery Guarantees

- **At-least-once**: if you don't ack, you'll get the event again next poll
- **Ordered**: events arrive in `event_id` order (insertion order)
- **Cursor-based**: your position is tracked per-subscriber, survives restarts
- **Visibility window**: events older than `expires_at` (72h default) are invisible
- **Sweep**: events are deleted after `dedup_expires_at` (24h default)

### What "At-Least-Once" Means for You

Your event handler should be idempotent. If you process `wicked.task.completed` for task `abc-123`, and then receive it again (because you crashed before acking), processing it a second time should be harmless.

Common patterns:
- Use the `idempotency_key` to check if you've already processed an event
- Use `INSERT OR IGNORE` when writing to your own database
- Make updates idempotent (set state to X, not increment by 1)

## Integration Patterns

### Fire-and-Forget (Recommended)

The bus should never slow down your plugin. Use dynamic import with a memoized check:

```javascript
let _emit = null;
let _checked = false;

async function emitToBus(eventType, domain, subdomain, payload) {
  if (!_checked) {
    _checked = true;
    try {
      const { emit } = await import('wicked-bus');
      const { loadConfig } = await import('wicked-bus/lib/config.js');
      const { openDb } = await import('wicked-bus/lib/db.js');
      const config = loadConfig();
      const db = openDb(config);
      _emit = (et, d, sd, p) => emit(db, config, {
        event_type: et, domain: d, subdomain: sd, payload: p,
      });
    } catch (_) {
      _emit = null;
    }
  }
  if (_emit) {
    try { return _emit(eventType, domain, subdomain, payload); }
    catch (_) { return null; }
  }
  return null;
}
```

If wicked-bus isn't installed, the check is memoized as null -- no repeated failed imports.

### Python (Subprocess)

Python plugins use the CLI via subprocess with a hard timeout:

```python
import subprocess, json, threading

def emit_to_bus(event_type, domain, payload, timeout_ms=100):
    def _fire():
        try:
            subprocess.run(
                ["npx", "wicked-bus", "emit",
                 "--type", event_type,
                 "--domain", domain,
                 "--payload", json.dumps(payload)],
                timeout=timeout_ms / 1000,
                capture_output=True
            )
        except Exception:
            pass  # Fire and forget

    threading.Thread(target=_fire, daemon=True).start()
```

## Troubleshooting

### "My subscriber isn't getting events"

1. Is the bus initialized? `wicked-bus status`
2. Does your filter match? `wicked.task.*` matches `wicked.task.completed` but not `wicked.task.step.completed`
3. Is the `@domain` suffix correct? It must match the `domain` column exactly
4. Are the events expired? Default visibility is 72 hours
5. Is your subscription deregistered? `wicked-bus list --include-deregistered`

### "I'm seeing WB-003 (cursor behind)"

Your cursor is pointing at an event that was already swept. You missed events between your cursor position and the oldest remaining event. Reset with:

```bash
wicked-bus replay --cursor-id {your-cursor} --event-id {latest-event-id}
```

To prevent this, poll frequently enough that events don't age out before you read them.

### "Events are disappearing"

Events are deleted by the sweep process after `dedup_expires_at` (24h by default). This is by design. If you need longer retention, adjust `dedup_ttl_hours` in your config:

```json
{
  "dedup_ttl_hours": 168
}
```
