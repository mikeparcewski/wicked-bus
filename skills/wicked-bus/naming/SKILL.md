---
name: naming
description: Pointer to the canonical wicked-bus event grammar — helps choose event_type, domain, and subdomain when emitting events. The grammar authority is reqs/SPEC.md ("Naming Convention"); this skill only summarizes it and shows worked examples. Use when creating new events, integrating a plugin with the bus, or reviewing event naming for consistency.
---

# wicked-bus Event Naming

> **Grammar authority: `reqs/SPEC.md` § "Naming Convention" (the v1 catalog).**
> This skill is a pointer with examples, not a second source of truth — when
> anything here and SPEC.md disagree, SPEC.md wins. Read the spec section for
> the normative rules and the WB-001 validation triggers.

## The grammar (from SPEC.md)

```
wicked.<domain>.<noun>.<past-tense-verb>
```

Four segments, always:

1. `wicked.` prefix
2. `<domain>` — the producing plugin's **short** name (`test`, `crew`,
   `garden`, `interactive`)
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
| `domain` | who did it — publisher identity (the `@domain` filter column) | full package name, e.g. `wicked-testing`; its short form is the type's 2nd segment |
| `subdomain` | where in the system — functional area | dot-separated hierarchy, e.g. `crew.phase`, `lifecycle.transform`; defaults to `''` |

Identity vs catalog: *which* instance/area an event concerns belongs in
`subdomain` (an indexed column), never as a 5th type segment. Don't invent a
new event_type per pipeline stage — reuse one type and vary `subdomain`.

## Worked examples

| Proposed | Valid? | Why |
|----------|--------|-----|
| `wicked.crew.deployment.started` + domain=`wicked-crew` | Yes | 4 segments, short domain, past tense |
| `wicked-testing.run.completed` | No | full package name in the type (use the short name) |
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
2. Is the 2nd segment YOUR plugin's short name? (Never emit under another
   producer's namespace — their catalog is theirs.)
3. Is instance identity (which stage/tenant/run) in `subdomain` or the
   payload, not baked into the type?
4. Uncertain about validation? SPEC.md § "Validation Rules (WB-001
   triggers)" is exhaustive.
