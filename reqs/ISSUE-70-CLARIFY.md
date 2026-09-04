# Clarify — Issue #70: Coerce interval config keys to finite numbers at the config layer

**Phase:** clarify (analysis / design / plan only — no production code)
**Target:** `lib/config.js` `loadConfig()`
**Related merged work:** #69 added `checkpoint_interval_minutes` + `lib/checkpoint.js` (confirmed present on this branch)

---

## 1. Problem statement

`loadConfig()` validates the two interval keys only with a `< 0` guard:

```js
// lib/config.js (current)
if (config.sweep_interval_minutes < 0) { throw ... }
if (config.checkpoint_interval_minutes < 0) { throw ... }
```

`config.json` is hand-editable. A user can write a **string** value, e.g.
`"sweep_interval_minutes": "abc"` or `"0"`. Those pass the current guard:

| user value      | `value < 0` | result today |
|-----------------|-------------|--------------|
| `"abc"`         | `"abc" < 0` → `false` (NaN compare) | passes, returned as string `"abc"` |
| `"0"`           | `"0" < 0` → `false` | passes, returned as string `"0"` |
| `"5"`           | `false`     | passes, returned as string `"5"` |
| `-1` (number)   | `true`      | throws (correct) |
| `"-1"` (string) | `"-1" < 0` → `true` | throws (JS coerces the comparison — inconsistent) |

Two concrete defects result:

### 1a. Type-unsoundness for TS consumers
`BusConfig` in `lib/config.d.ts` types both keys as `number`. `loadConfig()`
can return a `string` (or `NaN`) in those slots. TS consumers trust the
declared type; the runtime contradicts it. The `.d.ts` doc comment also
promises validation it does not fully perform.

### 1b. Latent 1ms-tick exposure in `startSweep`
Every consumer must currently defend itself:

- `startCheckpoint` (lib/checkpoint.js) **already coerces** — `Number(...)`,
  `!Number.isFinite → null`, floors the tick at 1000ms. Safe.
- `startSweep` (lib/sweep.js) **does not**:

  ```js
  if (!config.sweep_interval_minutes || config.sweep_interval_minutes === 0) return null;
  const intervalMs = config.sweep_interval_minutes * 60_000;
  return setInterval(..., intervalMs);
  ```

  - `"abc"` → truthy, `!== 0` → not disabled → `"abc" * 60000 = NaN` →
    `setInterval(fn, NaN)` → Node coerces `NaN` delay to **1ms** → tight
    sweep loop hammering the DB.
  - `"0"` → truthy (non-empty string), `"0" !== 0` (strict) → **not**
    disabled → `"0" * 60000 = 0` → `setInterval(fn, 0)` → clamped to 1ms →
    tight loop. (A user who wrote `"0"` intending "disable" gets the
    opposite.)

  `startSweep` is wired live in `commands/cmd-subscribe.js:234`, so this is
  reachable in production via a hand-edited config.

## 2. Root cause & chosen fix layer

The root cause is that `loadConfig()` merges raw JSON values through without
coercing declared-numeric keys to their declared type. Fixing per-consumer
(as checkpoint did) is defense-in-depth but leaves every future consumer to
re-discover the trap, and leaves the returned `BusConfig` type-unsound.

**Fix at the config layer**: coerce each interval key to a finite number
*before* validating and returning the merged config. This makes the returned
object honor `BusConfig`'s `number` typing and closes 1b at the source. Keep
the existing consumer-side guards (`startCheckpoint`'s coercion, and a
to-be-confirmed guard posture for `startSweep`) as defense in depth — do not
remove them.

## 3. Design — coercion semantics

For each of `sweep_interval_minutes` and `checkpoint_interval_minutes`, after
the merge (`{ ...DEFAULTS, ...userConfig, ...overrides }`) and the existing
null-override cleanup, before validation:

1. `const n = Number(config[key])`
2. If `Number.isFinite(n)` → use `n` (this preserves a legitimate `0`, and
   coerces a numeric string `"5"` → `5`).
3. Else (NaN / Infinity / -Infinity — covers `"abc"`, `""`, `true`/`false`
   via `Number`, `undefined`) → fall back to `DEFAULTS[key]` (the key's
   documented default: sweep 15, checkpoint 5).
4. Assign the coerced value back onto `config[key]`.

Then the **existing** `< 0` validation runs on the now-numeric value, so a
numeric `-1` (or `"-1"` coerced to `-1`) still throws — preserving current
behavior and the existing "throws when < 0" test.

### Semantics table (post-fix, for both interval keys)

| input                | `Number(x)` | finite? | coerced result | notes |
|----------------------|-------------|---------|----------------|-------|
| `5` (number)         | 5           | yes     | `5`            | unchanged |
| `"5"` (num string)   | 5           | yes     | `5`            | now a number ✅ |
| `"abc"` (garbage)    | NaN         | no      | default        | fail-safe ✅ |
| `""` (empty string)  | 0 ⚠️        | yes     | `0`            | see decision D1 |
| `-1` / `"-1"`        | -1          | yes     | `-1` → **throws** | validation still fires ✅ |
| `0` (number)         | 0           | yes     | `0`            | disables timer ✅ |
| `"0"` (string)       | 0           | yes     | `0`            | disables timer ✅ (was tight-loop bug) |
| `true` (boolean)     | 1           | yes     | `1` ⚠️          | see decision D2 |
| `false` (boolean)    | 0           | yes     | `0`            | disables timer |
| absent key           | default→num | yes     | default        | merge supplies default |
| absent config file   | default→num | yes     | default        | defaults used |

### Open decisions (resolve before/with implementation)

- **D1 — empty string `""`:** `Number("")` is `0`, not `NaN`. The task lists
  `""` as a required test case. Two defensible readings:
  - **(a) treat `""` as invalid → default** (recommended): an empty string is
    not a meaningful interval; a user who cleared the field most likely wants
    the default, not "disable". Requires special-casing `""` (and arguably
    whitespace-only) before `Number()`.
  - (b) let `Number("")===0` stand → disables the timer.
  Recommendation: **(a)**. The test for `""` should assert the default. Flag
  this to the reviewer; it is the one case where `Number()` alone doesn't
  match intuitive intent.

- **D2 — boolean `true`:** `Number(true)===1`. Task requires a `boolean` test.
  `false→0` (disable) is intuitive; `true→1` (1-minute interval) is a
  surprising-but-finite outcome. Options: accept the `Number()` result
  (`true→1`, `false→0`) for simplicity, or treat non-number/non-numeric-string
  types as invalid → default. Recommendation: **accept `Number()` semantics**
  (simplest, still finite and safe — no tight loop), and assert the concrete
  values in tests so the behavior is pinned. Reviewer may prefer the stricter
  "type must be number or numeric string" rule; note as a decision point.

- **D3 — scope of coercion:** apply ONLY to the two interval keys named in the
  issue. Do **not** coerce `ttl_hours`, `dedup_ttl_hours`, or
  `max_payload_bytes` in this change — out of scope, and their guards already
  throw on bad relative/`< 1` values. Keep the diff minimal.

## 4. Files to change (implementation phase — not now)

1. **`lib/config.js`**
   - Add coercion for the two interval keys after merge, before validation.
   - Update the `loadConfig` JSDoc where it describes validation to state that
     interval keys are coerced to finite numbers (invalid → default).
2. **`lib/config.d.ts`**
   - Update the `loadConfig` doc comment (and the two interval field docs in
     `BusConfig`) to promise the coercion contract accurately. No signature
     change — return type stays `BusConfig`; the point is the runtime now
     honors it.
3. **`lib/sweep.js`** (defense-in-depth confirmation)
   - Confirm/keep a guard. Since config now guarantees a finite number,
     `startSweep`'s existing `!x || x === 0` check becomes correct for all
     config-sourced values. Consider (optional, reviewer's call) mirroring
     `startCheckpoint`'s `Number(...) + Number.isFinite` + `Math.max(1000, …)`
     floor so a *direct* caller passing a raw string is still safe. Keep as
     defense in depth — do not rely solely on it.
   - **Do not remove** `startCheckpoint`'s existing coercion.

## 5. Test plan (`tests/unit/config.test.js`)

Add a `describe('interval key coercion')` block. For **each** interval key
(`sweep_interval_minutes`, `checkpoint_interval_minutes`) parametrize these
cases by writing `config.json` and asserting `loadConfig()` output:

| case                | config.json value | expected loadConfig result |
|---------------------|-------------------|----------------------------|
| numeric string      | `"5"`             | `5` (number, `typeof === 'number'`) |
| garbage string      | `"abc"`           | default (15 / 5) |
| negative number     | `-1`              | **throws** `/interval_minutes/` |
| negative string     | `"-1"`            | **throws** (coerced then validated) |
| zero number         | `0`               | `0` (timer-disabled sentinel preserved) |
| zero string         | `"0"`             | `0` |
| empty string        | `""`              | default (per D1a) |
| boolean true        | `true`            | `1` (per D2) — or default if stricter rule chosen |
| boolean false       | `false`           | `0` |
| absent key          | (key omitted)     | default |
| absent config file  | (no file written) | default (covered by existing test; add explicit typeof-number assert) |

Assertions must check both value AND `typeof === 'number'` for the
non-throwing cases (that's the type-soundness guarantee).

**Regression guard:** keep the existing "throws when sweep_interval_minutes
< 0" test green (the negative-number row above subsumes it; leave the
original in place).

Optionally add a `lib/sweep.js` test asserting `startSweep` returns `null`
(not a 1ms interval) when passed a config with `"0"` / `"abc"` — documents
the closed exposure. (Config-layer tests are the primary gate.)

## 6. Gates (must pass in implementation phase)

- `npm test` — full vitest suite incl. new coercion tests.
- `npm run typecheck` — `tsc -p test/types/tsconfig.json`; the updated
  `.d.ts` doc changes must not introduce drift.

## 7. Non-goals / out of scope

- No coercion of non-interval numeric keys (D3).
- No change to `writeDefaultConfig`.
- No change to the merge/override precedence order.
- No removal of existing consumer-side guards (defense in depth stays).
- No new dependency (pure `Number()` / `Number.isFinite`).

## 8. Risk notes

- **Low risk.** Change is localized to `loadConfig` between merge and
  validation; existing tests constrain the merge/override/validation paths.
- Behavior change users could notice: `"0"` now reliably **disables** the
  timer instead of tight-looping — this is the intended fix, and strictly
  safer.
- Watch D1 (`""`) — the only case where `Number()` semantics diverge from
  the recommended intent; the test pins whichever decision is taken.
