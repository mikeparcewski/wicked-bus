---
name: naming
description: Pointer to the canonical wicked-bus event grammar — helps choose event_type, domain, and subdomain when emitting events. The grammar authority is reqs/SPEC.md ("Naming Convention"); this skill only summarizes it and shows worked examples. Use when creating new events, integrating a plugin with the bus, or reviewing event naming for consistency.
---

# wicked-bus Event Naming

> **Grammar authority: `reqs/SPEC.md` § "Naming Convention" (the v1 catalog).**
> This skill is a pointer with examples, not a second source of truth — when
> anything here and SPEC.md disagree about the **event-type grammar**, SPEC.md
> wins. Scope note: SPEC.md's authority is the grammar and code structure; the
> `domain`/`subdomain` **column semantics** follow `reqs/DATA-DOMAIN.md` and the
> runtime schema (`lib/schema.sql`), and runtime validation is implemented in
> `lib/validate.js` (SPEC.md's envelope examples still show the retired
> `source_plugin` field).

## The grammar (from SPEC.md)

```
wicked.<domain>.<noun>.<past-tense-verb>
```

Four segments, always:

1. `wicked.` prefix
2. `<domain>` — the producing plugin's **short** name (`crew`, `garden`, `interactive`, …),
   or a **designed namespace** a producer owns and has catalogued (e.g. wicked-core publishes
   `wicked.team.*`, `wicked.gate.*` and `wicked.estate.*`). These names are examples. SPEC.md's
   generated event catalog is authoritative for the wicked-owned domains and designed
   namespaces: never reuse one of them for a producer that does not own it. A new external
   producer mints its own short domain by the same grammar, e.g. `wicked.myplugin.task.completed`
   with `domain=my-plugin` (README, USERS_GUIDE).
3. `<noun>` — the entity that changed (`run`, `phase`, `memory`, `gate`)
4. `<past-tense-verb>` — what happened (`completed`, `started`, `stored`,
   `failed`)

Lowercase, dot-separated, `[a-z0-9_]` per segment (no hyphens), max 128
chars. Three-segment names are not valid v1 catalog types. Producer-scoped
by design: `wicked.test.run.completed` ≠ `wicked.crew.run.completed`.

## The three identity fields

| Field | Purpose | Rule |
|-------|---------|------|
| `event_type` | who + what happened (catalogued) | the 4-segment grammar above |
| `domain` | who did it — publisher identity (the `@domain` filter column) | full package name, e.g. `wicked-crew`. The type's 2nd segment is its short form, or a designed namespace that package has catalogued: `wicked.team.path.started` is stamped `domain=wicked-core`, `subdomain=core.team` |
| `subdomain` | where in the system — functional area | dot-separated hierarchy, e.g. `crew.phase`, `lifecycle.transform`; defaults to `''` |

Identity vs catalog: *which* instance/area an event concerns belongs in
`subdomain` (an indexed column), never as a 5th type segment. Don't invent a
new event_type per pipeline stage — reuse one type and vary `subdomain`.

## Worked examples

| Proposed | Valid? | Why |
|----------|--------|-----|
| `wicked.crew.deployment.started` + domain=`wicked-crew` | Yes | 4 segments, short domain, past tense |
| `wicked.team.finding.raised` + domain=`wicked-core` | Yes | a designed namespace wicked-core owns and has catalogued |
| `wicked.team.finding.raised` + domain=`wicked-crew` | No | another producer's namespace |
| `wicked-crew.run.completed` | No | full package name in the type (use the short name) |
| `wicked.run.completed` | No | 3 segments — missing the domain segment |
| `wicked.crew.phase.start` | No | not past tense |
| `wicked.crew.phase-started` | No | hyphen in a segment |
| `wicked.test_run_completed` | No | underscores instead of dot segments |

## Emit + subscribe shapes

```bash
wicked-bus emit --type 'wicked.crew.phase.started' \
  --domain 'wicked-crew' --subdomain 'crew.phase' --payload '{"phase":"build"}'

wicked-bus subscribe --filter 'wicked.crew.phase.*'   # a producer's noun family
wicked-bus subscribe --filter '*@wicked-crew'         # everything from a domain
```

Remember: the bus is transport, not the system of record — payloads carry a
reference (an id) into the producer's durable store, and TTL sweeps apply.

## Checklist before emitting a new type

1. Does it match the SPEC.md grammar (4 segments, past tense, no hyphens)?
2. Is the 2nd segment YOUR plugin's short name, or a designed namespace YOUR package owns
   and has catalogued (listed under your package in SPEC.md's generated catalog)? Never emit
   under another producer's namespace: their catalog is theirs.
3. Is instance identity (which stage/tenant/run) in `subdomain` or the
   payload, not baked into the type?
4. Uncertain about validation? The implementation is `lib/validate.js`
   (WB-001 triggers); SPEC.md § "Validation Rules" documents the grammar-side
   rules — for `domain`/`subdomain` column semantics defer to `reqs/DATA-DOMAIN.md`
   and `lib/schema.sql`.
