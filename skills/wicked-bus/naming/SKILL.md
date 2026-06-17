---
name: wicked-bus:naming
description: Guide for naming wicked-bus events — helps choose event_type, domain, and subdomain when emitting events. Use when creating new events, integrating a plugin with the bus, or reviewing event naming for consistency.
---

# wicked-bus Event Naming

Interactive guide for naming events in the wicked-bus ecosystem. Helps users
choose correct event_type, domain, and subdomain values.

## When to use

- User is adding wicked-bus integration to a plugin
- User asks "how do I name this event" or "what event_type should I use"
- User is emitting events and needs to pick domain/subdomain
- Reviewing event names for consistency with the catalog
- User asks about the event naming convention

## The Three Fields

Every event has three identity fields:

| Field | Purpose | Rule |
|-------|---------|------|
| `event_type` | **What happened** — semantic, shared across producers | `wicked.<noun>.<past-tense-verb>` |
| `domain` | **Who did it** — the publishing plugin's package name | Your npm package name (e.g., `wicked-testing`) |
| `subdomain` | **Where in the system** — functional area within the plugin | Dot-separated hierarchy (e.g., `crew.phase`, `test.run`) |

## event_type Rules

Pattern: `wicked.<noun>.<past-tense-verb>`

1. Always starts with `wicked.`
2. Second segment = **noun** (the thing that changed): `run`, `phase`, `memory`, `project`, `gate`
3. Third segment = **past-tense verb** (what happened): `completed`, `started`, `stored`, `failed`, `created`
4. Lowercase, `[a-z0-9_]` only, dot-separated
5. Max 128 characters
6. **Semantic, not source-specific** — two plugins emitting the same kind of event share the type

### Common mistakes to catch

| Wrong | Problem | Correct |
|-------|---------|---------|
| `wicked-testing.run.completed` | Domain leaked into type | `wicked.run.completed` + domain=`wicked-testing` |
| `wicked.test_run_completed` | Underscores instead of dots | `wicked.run.completed` |
| `wicked.run.complete` | Not past tense | `wicked.run.completed` |
| `wicked.crew.phase.started` | Subdomain leaked into type (4 segments) | `wicked.phase.started` + subdomain=`crew.phase` |
| `run.completed` | Missing `wicked.` prefix | `wicked.run.completed` |

## domain Rules

1. A unique identifier for the publishing system — package name, service name, or tool name
2. Max 64 characters
3. One domain per system — don't subdivide at this level
4. This is what subscribers use in `@domain` filters

## subdomain Rules

1. Dot-separated hierarchy: `<area>.<entity>` (e.g., `deploy.staging`)
2. First segment = top-level area within your plugin
3. Second segment = specific entity or concern
4. Defaults to `''` if not provided
5. Max 64 characters
6. Can be arbitrarily deep if needed

## Process

When a user needs to name an event:

### Step 1: Identify what happened

Ask: "What changed and what happened to it?"

Map to: `wicked.<noun>.<past-tense-verb>`

- Thing created → `wicked.<thing>.created`
- Thing completed → `wicked.<thing>.completed`
- Thing failed → `wicked.<thing>.failed`
- Thing updated → `wicked.<thing>.updated`
- Thing deleted/removed → `wicked.<thing>.deleted`
- Thing started → `wicked.<thing>.started`

### Step 2: Identify the publisher

Ask: "What plugin is emitting this?"

Map to `domain` = their package name.

### Step 3: Identify the functional area

Ask: "What part of the system does this come from?"

Map to `subdomain` using the pattern `<area>.<entity>`. Examples:
- A deployment subsystem → `deploy.staging`
- An auth module → `auth.session`
- A build pipeline → `build.artifact`

### Step 4: Validate

Check that your event follows the rules:

1. event_type starts with `wicked.` and has exactly 3 dot-separated segments
2. Third segment is past tense (`created`, not `create`)
3. Domain doesn't appear in the event_type
4. Subdomain doesn't appear in the event_type
5. If another plugin emits the same semantic event, you should share the event_type

**Example validation:**

| Proposed | Valid? | Issue |
|----------|--------|-------|
| `wicked.deployment.started` + domain=`my-deploy` | Yes | |
| `my-deploy.deployment.started` | No | Domain in type |
| `wicked.deploy.staging.started` | No | 4 segments — subdomain leaked in |
| `wicked.deployment.start` | No | Not past tense |

### Step 5: Generate the emit call

```javascript
import { emit } from 'wicked-bus';

emit(db, config, {
  event_type: '{event_type}',
  domain: '{domain}',
  subdomain: '{subdomain}',
  payload: { /* event-specific data */ },
});
```

### Step 6: Show the subscriber filter

```bash
# All events of this type from any source
wicked-bus subscribe --filter '{event_type}'

# Only from this domain
wicked-bus subscribe --filter '{event_type}@{domain}'

# All events from this domain
wicked-bus subscribe --filter '*@{domain}'
```

## Design Decisions

**Why event_type is semantic (not source-specific):**
Same `wicked.project.created` from `wicked-garden` and `wicked-testing`.
A subscriber wanting "all project creations" uses one filter. Baking domain
into event_type forces subscribers to enumerate every producer.

**Why subdomain is a column (not in event_type):**
`wicked.phase.started` is semantic. Whether it's `crew.phase` or `deploy.phase`
is identity, not semantics. Columns enable index-based filtering.

## Worked example: lifecycle & gate events

> **This is an illustrative pattern, not a mandate.** wicked-bus does not ship,
> register, or enforce a lifecycle catalog — skills teach conventions, they do
> **not** hardcode other plugins' event catalogs. Treat the names below as an
> example a multi-stage pipeline tool **MAY** adopt to stay consistent with the
> `wicked.<noun>.<past-tense-verb>` convention. Pick the nouns/verbs that fit
> your domain; nothing here is reserved.

Many ecosystem tools run a **staged, gated pipeline** — an engine that moves work
through ordered stages, with governance gates between them (for example a
migration pipeline with stages like *discover → knowledge-base → spec → plan →
transform → validate → deliver/cutover*, each guarded by an approval gate). Such a
tool needs a consistent way to signal "a stage was entered/finished" and "a gate
cleared/blocked" so other tools can observe progress.

Here is one internally-consistent way to name those events under the existing
convention.

### Suggested event types

| Event type | Emitted when | Notes |
|------------|--------------|-------|
| `wicked.stage.entered` | A pipeline stage begins | noun=`stage`, verb=`entered` |
| `wicked.stage.completed` | A stage finishes successfully | mirror of `entered` |
| `wicked.gate.cleared` | A governance gate passes | the "go" signal |
| `wicked.gate.blocked` | A gate fails / withholds approval | the "stop" signal |
| `wicked.cutover.completed` | Final delivery/cutover succeeds | terminal milestone |

All five satisfy the rules: `wicked.` prefix, three segments, past-tense verb,
no domain or subdomain baked in. They are **semantic** — any pipeline engine
emitting "a stage was entered" shares `wicked.stage.entered`, regardless of which
tool it is.

### Suggested domain & subdomain

- **`domain`** = the engine/orchestrator's identity (its package or tool name),
  e.g. `domain = "engine"` (or `migration-factory`, `anti-legacy`, …). One domain
  per engine — don't subdivide here.
- **`subdomain`** = `lifecycle.<stage>` — the functional area plus the specific
  stage the event concerns, e.g. `lifecycle.transform`, `lifecycle.validate`,
  `lifecycle.cutover`. *Which* stage is identity, not semantics, so it belongs in
  the column, never in the event_type.

### How a multi-stage pipeline names its transitions

A 7-stage pipeline does **not** invent a new event_type per stage. It reuses the
five semantic types above and distinguishes the stage via `subdomain`:

```javascript
import { emit } from 'wicked-bus';

// Entering the "transform" stage
emit(db, config, {
  event_type: 'wicked.stage.entered',
  domain: 'engine',
  subdomain: 'lifecycle.transform',
  payload: { stage: 'transform', stage_number: 5, ref: '<authoritative-state-id>' },
});

// The gate guarding the transform→validate transition clears
emit(db, config, {
  event_type: 'wicked.gate.cleared',
  domain: 'engine',
  subdomain: 'lifecycle.transform',
  payload: { gate: 'transform', approver: 'architect', spec_version: '3.2.0' },
});

// A later gate withholds approval
emit(db, config, {
  event_type: 'wicked.gate.blocked',
  domain: 'engine',
  subdomain: 'lifecycle.validate',
  payload: { gate: 'validate', reason: 'acceptance criteria not green' },
});
```

### Why this shape filters well

Because the stage lives in `subdomain` and the engine in `domain`, subscribers
get expressive filters for free:

```bash
# Every gate outcome from any engine, any stage
wicked-bus subscribe --filter 'wicked.gate.*'

# Everything a specific engine emits across its whole lifecycle
wicked-bus subscribe --filter '*@engine'

# All lifecycle signals from anyone (stages + gates + cutover)
wicked-bus subscribe --filter 'wicked.**'
```

### The bus is transport, not the system of record

These events **announce** transitions; they do not **store** lifecycle state. The
bus is fire-and-forget transport and TTL-sweeps payloads — authoritative lifecycle
state (which stage you're in, who signed which gate) lives in the pipeline tool's
own durable store (its spec headers, DB, or audit log), not on the bus. Put a
reference (an id) in the payload and resolve details from the system of record;
never treat a polled event as the source of truth for current state.
