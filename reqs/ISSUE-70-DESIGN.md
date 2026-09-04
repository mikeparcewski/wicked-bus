# Design — Issue #70: Coerce interval config keys to finite numbers at the config layer

**Phase:** design (design/blueprint only — no production code)
**Consumes:** `reqs/ISSUE-70-CLARIFY.md`
**Target:** `lib/config.js` `loadConfig()` (+ `lib/config.d.ts` doc, `lib/sweep.js` defense-in-depth)
**Operator decisions applied:** D1 (empty string → default), D2 (booleans / non-numeric-string types → default, stricter rule), D3 (only the two named keys; other numeric keys are a PR follow-up note)

---

## 1. Locked semantics (decisions resolved)

The clarify phase left three open decisions. The operator resolved them; this
design is built on the resolved rules:

- **D1 — empty string:** `""` (and whitespace-only) → **key default**. Rationale:
  `Number("")===0` would silently *disable* the timer; an emptied field means
  "use default", not "disable".
- **D2 — stricter type rule:** only a `number` or a **numeric string** is a
  valid interval source. Booleans, `null`, objects, arrays, and any other
  non-numeric type → **key default**. `true`/`false` must be pinned in tests
  (both → default; they do NOT become `1`/`0`).
- **D3 — scope:** coerce ONLY `sweep_interval_minutes` and
  `checkpoint_interval_minutes`. The same class of latent unsoundness exists on
  `ttl_hours`, `dedup_ttl_hours`, `max_payload_bytes` — call that out as a
  follow-up note in the PR body; do **not** expand scope here.

## 2. Coercion contract (per interval key)

Given a raw merged value `v` and the key's documented default `d`
(`sweep=15`, `checkpoint=5`), the coerced value is:

| `v` (typeof)             | rule                                         | result |
|--------------------------|----------------------------------------------|--------|
| `number`, finite         | accept as-is (incl. `0`, incl. negatives)    | `v`    |
| `number`, non-finite (`NaN`/`±Infinity`) | invalid                       | `d`    |
| `string`, empty/whitespace | D1                                         | `d`    |
| `string`, numeric (`"5"`, `"-1"`, `" 5 "`) | parse via `Number(trim)`     | parsed |
| `string`, garbage (`"abc"`) | non-finite parse → invalid                | `d`    |
| `boolean` (`true`/`false`) | D2 (stricter)                              | `d`    |
| `null` / `undefined` / object / array | D2 (stricter)                   | `d`    |

Two important invariants:

1. **Negatives are preserved by coercion, then rejected by validation.** A
   finite negative (`-1` number, or `"-1"` string → `-1`) passes coercion
   unchanged and is caught by the existing `< 0` guard, which still `throw`s.
   This keeps the current "throws when `< 0`" behavior and its test green.
2. **A legitimate `0` (number or `"0"`) survives** as `0` → the timer-disable
   sentinel. This is the core bug fix: `"0"` no longer tight-loops in
   `startSweep`.

### Post-coercion effect on the two live consumers

- `startSweep(db, config)` (lib/sweep.js:68) — now always receives a finite
  number in `config.sweep_interval_minutes`. `"abc"`→15 (runs hourly-ish, not
  a 1ms spin), `"0"`→0 (correctly returns `null`/disabled).
- `startCheckpoint(db, config)` (lib/checkpoint.js) — already coerced; now
  double-safe. **Unchanged.**

## 3. Implementation blueprint (for the build phase — do NOT write code now)

### 3a. New private helper in `lib/config.js`

Add a module-private helper (not exported). Reference shape:

```js
/**
 * Coerce an interval config value to a finite number.
 * number (finite) → itself (incl. 0 and negatives — validation rejects < 0).
 * numeric string ("5", "-1") → parsed number. empty/whitespace string,
 * garbage string, boolean, and any other non-numeric type → `fallback`
 * (the key's documented default). Non-finite numbers → `fallback`.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function coerceInterval(value, fallback) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;            // D1
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;       // "abc"→fallback, "5"→5, "-1"→-1
  }
  return fallback;                                   // D2: boolean/null/object/array/undefined
}
```

Notes:
- `typeof NaN === 'number'` and `Number.isFinite(NaN)===false`, so a raw `NaN`
  in JSON (not representable in JSON, but possible via a direct override) →
  fallback. Covered.
- Using an explicit `typeof` gate (not bare `Number(value)`) is what enforces
  D2 — `Number(true)===1` is deliberately NOT reached.

### 3b. Call site in `loadConfig()`

Insert after the existing null-override cleanup loop and **before** the
validation block:

```js
config.sweep_interval_minutes = coerceInterval(
  config.sweep_interval_minutes, DEFAULTS.sweep_interval_minutes
);
config.checkpoint_interval_minutes = coerceInterval(
  config.checkpoint_interval_minutes, DEFAULTS.checkpoint_interval_minutes
);
```

The existing validation (`< 0` guards for both keys) then runs on guaranteed
numbers and is unchanged. Nothing else in `loadConfig` moves.

### 3c. `lib/sweep.js` — defense in depth (keep, optionally harden)

- **Keep** the existing `if (!config.sweep_interval_minutes || … === 0) return null;`
  guard. With config now finite it is correct for all config-sourced values.
- **Optional (reviewer's call):** mirror `startCheckpoint`'s pattern —
  `Number(...)` + `Number.isFinite` + `Math.max(1000, minutes * 60_000)` floor —
  so a *direct* caller passing a raw string is still safe. This is additive
  defense in depth, not required for the config-layer fix. If added, it must
  not change behavior for finite inputs (a floor of 1000ms only affects
  sub-second positive fractions, which config validation already permits).
- **Do NOT remove** `startCheckpoint`'s coercion.

Decision for the build phase: hardening `startSweep` to structurally match
`startCheckpoint` is **recommended** (symmetry + closes the direct-caller gap),
but the acceptance gate is the config-layer coercion. Either way, the existing
consumer guards remain.

### 3d. Doc comment updates

- **`lib/config.js`** — `loadConfig` JSDoc: add a line stating that
  `sweep_interval_minutes` and `checkpoint_interval_minutes` are coerced to a
  finite number; invalid/empty/non-numeric values fall back to the documented
  default; a legitimate `0` is preserved (disables the timer).
- **`lib/config.d.ts`**:
  - `loadConfig` doc block + `@throws` note: reflect that interval keys are
    coerced (so the returned `BusConfig` honors the `number` typing) and that
    a coerced negative still throws.
  - `BusConfig.sweep_interval_minutes` / `.checkpoint_interval_minutes` field
    docs: note "coerced to a finite number by loadConfig; invalid → default".
  - No signature change — the point is the runtime now honors the declared
    `number` type.

## 4. Test design (`tests/unit/config.test.js`)

Add a `describe('interval key coercion')` block. Parametrize over both keys
`['sweep_interval_minutes', 'checkpoint_interval_minutes']` with defaults
`{ sweep: 15, checkpoint: 5 }`. Each case writes `config.json` (via the
existing `tmpDir` + `WICKED_BUS_DATA_DIR` harness) and asserts on
`loadConfig()` output.

| # | case              | written value | expectation                                   |
|---|-------------------|---------------|-----------------------------------------------|
| 1 | numeric string    | `"5"`         | `=== 5` AND `typeof === 'number'`             |
| 2 | garbage string    | `"abc"`       | `=== default` (15 / 5), `typeof number`       |
| 3 | negative number   | `-1`          | `loadConfig` **throws** `/interval_minutes/`  |
| 4 | negative string   | `"-1"`        | **throws** (coerced to `-1`, then validated)  |
| 5 | zero number       | `0`           | `=== 0`, `typeof number`                       |
| 6 | zero string       | `"0"`         | `=== 0`, `typeof number`                        |
| 7 | empty string      | `""`          | `=== default` (D1), `typeof number`            |
| 8 | boolean true      | `true`        | `=== default` (D2 — NOT `1`), `typeof number`  |
| 9 | boolean false     | `false`       | `=== default` (D2 — NOT `0`), `typeof number`  |
|10 | absent key        | key omitted   | `=== default`, `typeof number`                 |
|11 | absent config file| no file       | `=== default`, `typeof number`                 |

Assertion rules:
- Non-throwing rows assert **both** the numeric value AND `typeof === 'number'`
  (the type-soundness guarantee is the whole point).
- Rows 3 & 4 use `expect(() => loadConfig()).toThrow(...)`.
- Row 4 confirms coercion happens *before* validation (string negative still
  throws) — this is a deliberate ordering test.
- Rows 8 & 9 are the D2 pins: `true`/`false` must land on the default, proving
  the stricter type rule (guards against a future refactor to bare `Number()`).

Keep the existing `throws when sweep_interval_minutes < 0` test as-is (row 3
subsumes it but the original stays for regression).

Optional sweep-layer test (`tests/unit/sweep.test.js`): assert
`startSweep(db, { sweep_interval_minutes: '0' })` returns `null` and
`{ sweep_interval_minutes: 'abc' }` does not create a 1ms interval — documents
the closed exposure at the consumer. Primary gate remains the config tests.

## 5. Gates

- `npm test` — full vitest suite incl. the new coercion block.
- `npm run typecheck` — `tsc -p test/types/tsconfig.json`; the `.d.ts` doc
  edits must not introduce drift.

## 6. PR body follow-up note (required by D3, not implemented here)

> Follow-up: `ttl_hours`, `dedup_ttl_hours`, and `max_payload_bytes` share the
> same class of latent type-unsoundness — a hand-edited string in config.json
> is validated by relative/`< 1` comparisons that JS coerces inconsistently,
> and `BusConfig` types them as `number`. Out of scope for #70 (which is
> interval-specific); worth a follow-up issue to apply the same
> `coerceInterval`-style numeric coercion (or a shared numeric-key coercion
> pass) to those keys.

## 7. Non-goals / risk

- **Non-goals:** no coercion of non-interval keys; no change to
  `writeDefaultConfig`, merge order, or override precedence; no new dependency
  (pure `typeof` + `Number` + `Number.isFinite`); no removal of consumer guards.
- **Risk:** low, localized between merge and validation. Only observable
  behavior change is the intended fix (`"0"`/garbage no longer tight-loop; they
  disable / fall back to default). Existing tests constrain the untouched
  paths.

---

No production code written in this phase. No external-transform assumptions
apply — the fix is pure in-process `Number()`/`typeof` coercion with no
third-party payload transformation.
