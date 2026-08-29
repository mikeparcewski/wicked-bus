# User's Guide

A practical guide for integrating with wicked-bus. Covers how to name events, structure payloads, and connect your tools and agents to the bus.

## How Events Work

Every event in wicked-bus has three identity fields and a payload:

```
┌─────────────────────────────────────────────────────┐
│  event_type: wicked.mydeploy.deployment.completed   │  ← What happened
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
wicked.<domain>.<noun>.<past-tense-verb>
```

Four segments. Always starts with `wicked.`. The domain is the producing plugin's short name
(the full package name also goes in the `domain` column). The noun is the thing that changed.
The verb is past tense -- what already happened. (Examples below use `myapp` as the producer.)

### Examples

| Event Type | What It Means |
|------------|--------------|
| `wicked.myapp.deployment.completed` | A deployment finished |
| `wicked.myapp.deployment.started` | A deployment began |
| `wicked.myapp.deployment.failed` | A deployment failed |
| `wicked.myapp.task.created` | A task was created |
| `wicked.myapp.cache.invalidated` | A cache was cleared |
| `wicked.myapp.build.completed` | A build finished |
| `wicked.myapp.report.generated` | A report was produced |

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
| `wicked.task.completed` | Missing the domain segment (only three) | `wicked.myapp.task.completed` |
| `my-plugin.task.completed` | Domain baked into the type instead of the `domain` column | `wicked.myplugin.task.completed` + domain=`my-plugin` (the type's 2nd segment is the short form of the domain) |
| `wicked.myapp.task.complete` | Not past tense | `wicked.myapp.task.completed` |
| `task.completed` | Missing `wicked.` prefix | `wicked.myapp.task.completed` |
| `wicked.myapp.taskCompleted` | camelCase | `wicked.myapp.task.completed` |

## Choosing Your Domain

Your domain is a unique identifier for the system emitting events. It can be a package name, a service name, a tool name, or any string that uniquely identifies the publisher.

Examples: `my-deploy-tool`, `acme-ci`, `wicked-garden`, `backend-api`, `data-pipeline`

Rules:
- One domain per system/tool
- Max 64 characters
- Lowercase, hyphens are fine
- This is what subscribers use in `@domain` filters
- Pick something stable — subscribers will filter on it

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

## Worked Example: Lifecycle Events

> **Illustrative pattern, not a mandate.** wicked-bus does not ship, register, or
> enforce a lifecycle catalog. The names below are an example a staged-pipeline
> tool *may* adopt to stay consistent with the `wicked.<domain>.<noun>.<past-tense-verb>`
> convention. Pick nouns/verbs that fit your domain — nothing here is reserved.
> (For the *real* gate events other wicked products emit, see
> [Gate Events](#gate-events-two-distinct-gates-in-the-ecosystem) below — those
> are a catalog, not an illustration.)

A tool that runs a **staged pipeline** (an engine moving work through ordered
stages) needs a consistent way to signal "a stage was entered/completed". The
example engine's short domain name is `engine`.

### Suggested event types

| Event type | Emitted when |
|------------|--------------|
| `wicked.engine.stage.entered` | A pipeline stage begins |
| `wicked.engine.stage.completed` | A stage finishes successfully |

Both satisfy the rules: `wicked.` prefix, four segments, producer named in the
domain segment, past-tense verb. *Which* stage is carried in `subdomain`
(`lifecycle.<stage>`), never baked into a per-stage type.

### Suggested domain & subdomain

- **`domain`** = the engine's identity, e.g. `engine`. One domain per engine.
- **`subdomain`** = `lifecycle.<stage>` — e.g. `lifecycle.transform`,
  `lifecycle.validate`. *Which* stage is identity, so it belongs in the column,
  never in the event_type.

A multi-stage pipeline does **not** invent a new event_type per stage. It reuses
the semantic types above and distinguishes the stage via `subdomain`:

```javascript
import { emit } from 'wicked-bus';

// Entering the "transform" stage
emit(db, config, {
  event_type: 'wicked.engine.stage.entered',
  domain: 'engine',
  subdomain: 'lifecycle.transform',
  payload: { stage: 'transform', ref: '<authoritative-state-id>' },
});

// The "transform" stage finishes
emit(db, config, {
  event_type: 'wicked.engine.stage.completed',
  domain: 'engine',
  subdomain: 'lifecycle.transform',
  payload: { stage: 'transform', ref: '<authoritative-state-id>' },
});
```

Because the stage lives in `subdomain` and the engine in `domain`, subscribers
get expressive filters for free:

```bash
wicked-bus subscribe --filter 'wicked.engine.stage.*'   # every stage transition
wicked-bus subscribe --filter '*@engine'                # everything that engine emits
```

These events **announce** transitions; they do not **store** lifecycle state. The
bus is fire-and-forget transport and TTL-sweeps payloads — authoritative state
lives in the pipeline tool's own durable store. Put a reference (an id) in the
payload and resolve details from the system of record; never treat a polled event
as the source of truth for current state.

## Gate Events: Two Distinct Gates in the Ecosystem

Governance "gates" are where the wicked ecosystem signals go/stop. **There is no
single unified gate-outcome catalog.** Two different kinds of gate run in the
ecosystem, and they live in **separate event namespaces disambiguated by
producer `domain`**. Subscribe to the one you actually care about — do not
assume a single gate stream, and do not emit these names yourself unless you
are one of these producers.

### 1. QE acceptance gate — domain `qe`, produced by wicked-garden's QE pipeline

The QE acceptance pipeline decides whether captured evidence clears the quality
bar. The producer today is **wicked-garden's `qe` skill domain**: the gate CLI
ships in garden's plugin catalog (`scripts/qe/lib/gate.mjs`) and the
QE-lifecycle emissions go through **wicked-ledger**. Every QE event stamps the
bus `domain` column with **`qe`**.

<!-- historical -->
> **Retirement note:** this wire contract was established by the retired
> **wicked-testing** package (retired 2026-08, Phase 6). The event types and
> the 8-field gate payload were kept **stable by decision** — only the producer
> moved (garden's qe skills + wicked-ledger) and the `domain` stamp rebranded
> from `wicked-testing` to `qe`. If an old integration subscribes with
> `@wicked-testing`, it matches nothing today — use `@qe`.
<!-- /historical -->

| Event type | Emitted when |
|------------|--------------|
| `wicked.qe.gate.passed` | Acceptance passed — evidence meets the bar |
| `wicked.qe.gate.failed` | Acceptance failed — evidence does not meet the bar |
| `wicked.qe.gate.conditional` | Conditional pass (or SYSTEM_ERROR) — accepted with noted caveats |
| `wicked.qe.deploy.completed` | Cross-product deploy signal, emitted alongside a PASS |

Gate events carry an 8-field payload: `run_id`, `context`, `gate_verdict`,
`exit_code`, `verdict_summary`, `mode`, `completed_at`, `scenario_count`
(`wicked.qe.deploy.completed` carries `run_id`, `project_id`).

```bash
# Every QE acceptance-gate outcome
wicked-bus subscribe --filter 'wicked.qe.gate.*'

# Explicit about the producer domain (the domain column is `qe`)
wicked-bus subscribe --filter 'wicked.qe.gate.*@qe'
```

The reference consumer is **wicked-crew**: its daemon registers a durable
subscriber (plugin `wicked-crew`, filter `wicked.qe.**`) and folds gate results
into its acceptance view (`GET /runs/:id/acceptance`) — the ledger stays the
system of record, so a lost or replayed event can never flip a verdict.

### 2. Workflow phase gates — produced by `wicked-garden` and the crew engine

Phase-gate decisions in governed workflows are announced under the producers'
own domains:

| Event type | Producer `domain` | Emitted when |
|------------|-------------------|--------------|
| `wicked.garden.gate.decided` | `wicked-garden` | A phase gate returned APPROVE, CONDITIONAL, or REJECT — the decision detail lives in the payload |
| `wicked.garden.gate.blocked` | `wicked-garden` | A phase gate returned REJECT — phase advancement blocked (the "stop" signal) |
| `wicked.crew.phase.transitioned` | `wicked-garden` | The coarse phase-transition fact (`phase_from` → `phase_to`) each approved transition emits |

```bash
# Every garden phase-gate signal
wicked-bus subscribe --filter 'wicked.garden.gate.*'

# Every phase transition
wicked-bus subscribe --filter 'wicked.crew.phase.*'
```

### Why they are separate

The two gates answer different questions — *does this evidence clear QE?* versus
*may this workflow phase advance?* — run in different products, and are **not
interchangeable**. Keeping them in distinct namespaces (`wicked.qe.gate.*` versus
`wicked.garden.gate.*`) means one filter never sweeps in the other gate's
stream. Add the `@domain` suffix (`wicked.qe.gate.*@qe`,
`wicked.garden.gate.*@wicked-garden`) when you want to be explicit about the
producer. These are the events actually emitted today; `wicked.gate.cleared`
and a unified gate-outcome namespace are **not** real — do not subscribe to or
emit them.

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
| `wicked.myapp.task.completed` | Exactly that event type |
| `wicked.myapp.task.*` | One segment deep: `wicked.myapp.task.created`, `wicked.myapp.task.completed` — NOT `wicked.myapp.task.step.completed` |
| `wicked.myapp.task.**` | One **or more** segments deep: `wicked.myapp.task.created` AND `wicked.myapp.task.step.completed` |
| `wicked.**` | Everything under `wicked.` — every `wicked.<domain>.<noun>.<verb>` event |
| `*@my-plugin` | Everything from `my-plugin` |
| `wicked.myapp.task.*@my-plugin` | Task events (one segment deep) from `my-plugin` only |

`*` matches exactly one segment (single-level). `**` matches one or more
segments (multi-level). Because every event type is `wicked.<domain>.<noun>.<verb>`
(4 segments), use `wicked.**` — not `wicked.*` — to "subscribe to everything
under `wicked`". A trailing `**` requires at least one segment after the
prefix; it does not match the bare prefix on its own.

### Delivery Guarantees

- **At-least-once**: if you don't ack, you'll get the event again next poll
- **Ordered**: events arrive in `event_id` order (insertion order)
- **Cursor-based**: your position is tracked per-subscriber, survives restarts
- **Visibility window**: events older than `expires_at` (72h default) are invisible
- **Sweep**: events are deleted after `dedup_expires_at` (24h default)

### What "At-Least-Once" Means for You

Your event handler should be idempotent. If you process `wicked.myapp.task.completed` for task `abc-123`, and then receive it again (because you crashed before acking), processing it a second time should be harmless.

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
      // Everything is exported from the package root — deep
      // 'wicked-bus/lib/...' imports are blocked by the exports map.
      const { emit, loadConfig, openDb } = await import('wicked-bus');
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
2. Does your filter match? `wicked.myapp.task.*` matches `wicked.myapp.task.completed` but not `wicked.myapp.task.step.completed` (use `wicked.myapp.task.**` for the latter, or `wicked.**` for everything)
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
