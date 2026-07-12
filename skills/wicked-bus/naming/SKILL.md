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
| `event_type` | **Who + what happened** — producer-scoped, catalogued | `wicked.<domain>.<noun>.<past-tense-verb>` |
| `domain` | **Who did it** — the publishing plugin's package name | Your npm package name (e.g., `wicked-testing`) |
| `subdomain` | **Where in the system** — functional area within the plugin | Dot-separated hierarchy (e.g., `crew.phase`, `test.run`) |

> **Grammar authority:** the canonical event-type grammar is **four segments**,
> `wicked.<domain>.<noun>.<past-tense-verb>`, per `reqs/SPEC.md` (the v1 catalog).
> The `<domain>` segment is the producing plugin's **short** name (`test`, `crew`,
> `brain`, `interactive`, `garden`); the `domain` *column* carries the full package
> name (`wicked-testing`). Both are populated — the short name scopes the type so a
> catalogued event is self-describing, and the column drives `@domain` filters.

## event_type Rules

Pattern: `wicked.<domain>.<noun>.<past-tense-verb>`

1. Always starts with `wicked.`
2. Second segment = **domain** (the producing plugin's short name): `test`, `crew`, `brain`, `interactive`, `garden`
3. Third segment = **noun** (the thing that changed): `run`, `phase`, `memory`, `project`, `gate`
4. Fourth segment = **past-tense verb** (what happened): `completed`, `started`, `stored`, `failed`, `created`
5. Lowercase, `[a-z0-9_]` only, dot-separated (no hyphens — a hyphen in any segment is invalid)
6. Max 128 characters
7. **Producer-scoped** — the domain segment names who emits it, so two products' same-noun events stay distinct (`wicked.test.run.completed` ≠ `wicked.crew.run.completed`)

### Common mistakes to catch

| Wrong | Problem | Correct |
|-------|---------|---------|
| `wicked-testing.run.completed` | Full package name in the domain segment (use the short name) + missing a segment | `wicked.test.run.completed` |
| `wicked.test_run_completed` | Underscores instead of dots | `wicked.test.run.completed` |
| `wicked.crew.phase.start` | Not past tense | `wicked.crew.phase.started` |
| `wicked.crew.phase-started` | Hyphen in a segment (only `[a-z0-9_]` allowed) | `wicked.crew.phase.started` |
| `wicked.run.completed` | Missing the domain segment (only 3 segments) | `wicked.test.run.completed` |
| `run.completed` | Missing `wicked.` prefix | `wicked.test.run.completed` |

## domain Rules

1. A unique identifier for the publishing system — the plugin's package name
2. Max 64 characters
3. One domain per system — don't subdivide at this level
4. This is what subscribers use in `@domain` filters
5. The `event_type`'s second segment is the **short** form of this same domain

## subdomain Rules

1. Dot-separated hierarchy: `<area>.<entity>` (e.g., `deploy.staging`)
2. First segment = top-level area within your plugin
3. Second segment = specific entity or concern
4. Defaults to `''` if not provided
5. Max 64 characters
6. Can be arbitrarily deep if needed

## Process

When a user needs to name an event:

### Step 1: Identify the publisher

Ask: "What plugin is emitting this?"

Map to the **domain** — its package name (`wicked-testing`) — and take its **short
form** (`test`) for the event_type's second segment.

### Step 2: Identify what happened

Ask: "What changed and what happened to it?"

Map to `<noun>.<past-tense-verb>` (the 3rd and 4th segments):

- Thing created → `wicked.<domain>.<thing>.created`
- Thing completed → `wicked.<domain>.<thing>.completed`
- Thing failed → `wicked.<domain>.<thing>.failed`
- Thing updated → `wicked.<domain>.<thing>.updated`
- Thing deleted/removed → `wicked.<domain>.<thing>.deleted`
- Thing started → `wicked.<domain>.<thing>.started`

### Step 3: Identify the functional area

Ask: "What part of the system does this come from?"

Map to `subdomain` using the pattern `<area>.<entity>`. Examples:
- A deployment subsystem → `deploy.staging`
- An auth module → `auth.session`
- A build pipeline → `build.artifact`

### Step 4: Validate

Check that your event follows the rules:

1. event_type starts with `wicked.` and has exactly 4 dot-separated segments
2. Second segment is the producer's short domain name
3. Fourth segment is past tense (`created`, not `create`)
4. No hyphens in any segment — only `[a-z0-9_]`
5. The full package name lives in the `domain` column (the short form in the type)

**Example validation:**

| Proposed | Valid? | Issue |
|----------|--------|-------|
| `wicked.crew.deployment.started` + domain=`wicked-crew` | Yes | |
| `my-deploy.deployment.started` | No | Missing `wicked.` prefix / short domain |
| `wicked.deployment.started` | No | 3 segments — missing the domain segment |
| `wicked.crew.deployment.start` | No | Not past tense |

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
# All events of this exact type (already producer-scoped by its domain segment)
wicked-bus subscribe --filter '{event_type}'

# All events from a domain, using the @domain column filter
wicked-bus subscribe --filter '*@{domain}'

# A whole product's noun family via a type-prefix glob
wicked-bus subscribe --filter 'wicked.{domain}.{noun}.*'
```

## Design Decisions

**Why the domain is in the event_type (producer-scoped):**
The v1 catalog scopes each event to its producer — `wicked.test.run.completed`
is wicked-testing's run event, `wicked.crew.phase.started` is crew's phase event.
A catalogued type is self-describing: you can tell who emits it from the type
alone, and two products that both have a "run" never collide. Cross-producer
"same kind of event" queries are expressed with a type glob or the `@domain`
column filter, not by overloading one bare type across every producer.

**Why subdomain is still a column (not a 5th segment):**
`wicked.crew.phase.started` names the producer (crew) and the semantic event
(phase started). *Which* phase instance / functional area (`crew.phase` vs a
finer area) is identity, not catalog semantics — it lives in the indexed
`subdomain` column so it can be filtered without inflating the type.

## Worked example: lifecycle events

> **This is an illustrative pattern, not a mandate.** wicked-bus does not ship,
> register, or enforce a lifecycle catalog — skills teach conventions, they do
> **not** hardcode other plugins' event catalogs. Treat the names below as an
> example that a multi-stage pipeline tool **MAY** adopt to stay consistent with the
> `wicked.<domain>.<noun>.<past-tense-verb>` convention. Pick the nouns/verbs that
> fit your domain; nothing here is reserved. (The *real* gate events wicked products
> emit are catalogued separately in
> [Real gates in the ecosystem](#real-gates-in-the-ecosystem-two-namespaces-not-one)
> below — those are not hypothetical.)

Many ecosystem tools run a **staged pipeline** — an engine that moves work
through ordered stages (for example a migration pipeline with stages like
*discover → knowledge-base → spec → plan → transform → validate →
deliver/cutover*). Such a tool needs a consistent way to signal "a stage was
entered/completed" so other tools can observe progress.

Here is one internally-consistent way to name those events under the existing
convention, for an engine whose short domain name is `engine`.

### Suggested event types

| Event type | Emitted when | Notes |
|------------|--------------|-------|
| `wicked.engine.stage.entered` | A pipeline stage begins | domain=`engine`, noun=`stage`, verb=`entered` |
| `wicked.engine.stage.completed` | A stage finishes successfully | mirror of `entered` |
| `wicked.engine.pipeline.completed` | The whole pipeline reaches its terminal milestone (e.g. delivery/cutover) | terminal milestone — stage carried in `subdomain` |

All three satisfy the rules: `wicked.` prefix, four segments, past-tense verb,
producer named in the domain segment, no hyphens. *Which* stage the event
concerns is carried in `subdomain`, not baked into a per-stage type.

### Suggested domain & subdomain

- **`domain`** = the engine/orchestrator's identity (its package or tool name),
  e.g. `domain = "engine"` (or `migration-factory`, `anti-legacy`, …). One domain
  per engine — don't subdivide here. The event_type's second segment is its short form.
- **`subdomain`** = `lifecycle.<stage>` — the functional area plus the specific
  stage the event concerns, e.g. `lifecycle.transform`, `lifecycle.validate`,
  `lifecycle.cutover`. *Which* stage is identity, not catalog semantics, so it
  belongs in the column, never as an extra type segment.

### How a multi-stage pipeline names its transitions

A 7-stage pipeline does **not** invent a new event_type per stage. It reuses the
three types above and distinguishes the stage via `subdomain`:

```javascript
import { emit } from 'wicked-bus';

// Entering the "transform" stage
emit(db, config, {
  event_type: 'wicked.engine.stage.entered',
  domain: 'engine',
  subdomain: 'lifecycle.transform',
  payload: { stage: 'transform', stage_number: 5, ref: '<authoritative-state-id>' },
});

// The "transform" stage finishes; the engine advances to "validate"
emit(db, config, {
  event_type: 'wicked.engine.stage.completed',
  domain: 'engine',
  subdomain: 'lifecycle.transform',
  payload: { stage: 'transform', stage_number: 5, ref: '<authoritative-state-id>' },
});
```

### Why this shape filters well

Because the producer lives in both the type's domain segment and the `domain`
column, and the stage lives in `subdomain`, subscribers get expressive filters:

```bash
# Every stage transition from this engine, any stage
wicked-bus subscribe --filter 'wicked.engine.stage.*'

# Everything a specific engine emits across its whole lifecycle
wicked-bus subscribe --filter '*@engine'
```

### The bus is transport, not the system of record

These events **announce** transitions; they do not **store** lifecycle state. The
bus is fire-and-forget transport and TTL-sweeps payloads — authoritative lifecycle
state (which stage you're in, who signed which gate) lives in the pipeline tool's
own durable store (its spec headers, DB, or audit log), not on the bus. Put a
reference (an id) in the payload and resolve details from the system of record;
never treat a polled event as the source of truth for current state.

## Real gates in the ecosystem (two namespaces, not one)

The `wicked.engine.*` names in the illustrative pipeline above are a *hypothetical*
engine — not a real catalog. In the actual wicked ecosystem there is **no single
gate catalog**: two products run two different gates, in two **separate namespaces
disambiguated by producer `domain`**. This is a naming lesson worth internalizing —
know which gate you mean before you filter (and never emit these unless you are the
producer that owns them):

| Gate | Producer `domain` | Event types emitted |
|------|-------------------|---------------------|
| **QE acceptance gate** | `wicked-testing` | `wicked.qe.gate.passed`, `wicked.qe.gate.failed`, `wicked.qe.gate.conditional`, `wicked.qe.deploy.completed` |
| **Crew phase gate** | `wicked-garden` | `wicked.gate.decided` (a *command* — it directs the next step, not a pass/fail outcome), `wicked.gate.blocked` |

Same word ("gate"), two distinct real events, told apart by `domain` and by
namespace prefix (`wicked.qe.gate.*` versus `wicked.gate.*`). `wicked.qe.gate.*`
matches only wicked-testing's QE gate; it does **not** reach wicked-garden's crew
gate. There is **no** `wicked.gate.cleared` and **no** unified gate stream — do not
emit or subscribe to them. See the wicked-bus User's Guide for full payload fields.
