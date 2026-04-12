# wicked-bus Development Guide

## Project Structure

```
wicked-bus/
  lib/               # Core library modules (ESM)
    schema.sql       # Full DDL (source of truth for tables)
    db.js            # SQLite connection, PRAGMAs, schema bootstrap
    emit.js          # Event emission with idempotency + TTL
    poll.js          # Cursor-based polling with filter matching
    sweep.js         # TTL sweep with optional archive
    register.js      # Provider/subscriber registration
    validate.js      # Event schema validation
    config.js        # Config loading, defaults, env overrides
    paths.js         # Cross-platform data directory resolution
    errors.js        # WBError class, error codes, exit codes
    index.js         # ESM public API re-exports
    index.cjs        # CJS shim
  commands/          # CLI command modules
    cli.js           # Entry point, arg parser, command router
    cmd-*.js         # One file per command (10 commands)
  skills/            # SKILL.md files installed into AI CLIs
    wicked-bus/      # Skill namespace
      init/          # Bus initialization and health check
      emit/          # Publishing events
      subscribe/     # Consuming events
      naming/        # Event naming conventions
      query/         # Querying and debugging
  scripts/
    postinstall.js   # Auto-init data dir on npm install
  tests/
    unit/            # Per-module unit tests
    integration/     # Multi-module flow tests
    cli/             # CLI subprocess tests
    api/             # Export surface tests
    fixtures/        # Test data files
  install.mjs        # CLI installer (detects AI CLIs, copies skills)
  reqs/              # Requirement specs (reference only)
```

## Architecture

Single npm package with two interfaces:
1. **Library** — `import { emit, poll, ack } from 'wicked-bus'`. SQLite-backed, synchronous, no async needed.
2. **CLI** — `wicked-bus emit|subscribe|status|...`. Structured JSON to stdout, errors to stderr.
3. **Skills** — Markdown instruction files that teach AI agents how to use the bus.

All state lives in `~/.something-wicked/wicked-bus/bus.db` (SQLite, WAL mode). Override with `WICKED_BUS_DATA_DIR` env var.

## Development Rules

### Code Style
- Plain JavaScript (ESM). No TypeScript, no build step.
- `"type": "module"` in package.json. All `.js` files are ESM.
- Dependencies: `uuid` (runtime), `better-sqlite3` (peer). That's it. Every new dependency needs justification.
- Tests use `vitest`. Run: `npm test`

### Schema
- `lib/schema.sql` is the source of truth for all table definitions.
- Events table uses `domain` + `subdomain` columns (NOT `source_plugin`).
- Event type pattern: `wicked.<noun>.<past-tense-verb>` (3 dot-separated segments).
- `domain` is the publisher identity (any unique string — package name, service name, tool name).
- `subdomain` is the functional area within the publisher (dot-separated, e.g., `crew.phase`).
- Where SPEC.md and DATA-DOMAIN.md conflict, SPEC.md is authoritative for code structure; DATA-DOMAIN.md is authoritative for the domain/subdomain column model.

### Error Handling
- Six error codes: WB-001 through WB-006.
- All errors are `WBError` instances with structured JSON output.
- CLI maps error codes to exit codes (WB-001 → exit 1, etc.).
- Never throw raw errors from public API — always wrap in WBError.

### CLI
- Raw `process.argv` parsing (no framework).
- Global flags: `--db-path`, `--json`, `--log-level`.
- All commands output JSON to stdout. Errors to stderr.
- CLI tests spawn the actual binary via `execFileSync` with `WICKED_BUS_DATA_DIR` isolation.

### Cross-Platform
- All code must work on macOS, Linux, and Windows.
- Use `node:path.join()` for all path construction.
- `paths.js` resolution order: `WICKED_BUS_DATA_DIR` env → platform-specific home dir.
- Tests that set `HOME` must also clear `APPDATA`/`USERPROFILE` on Windows.
- Skills must provide macOS/Linux + Windows alternatives when using shell commands.

### Skills
- Live in `skills/wicked-bus/{name}/SKILL.md`.
- YAML frontmatter with `description` field (used for skill discovery).
- Skills teach patterns and conventions — they do NOT hardcode other plugins' event catalogs.
- Domain is described as "any unique identifier" — not tied to npm package names.

### Testing
- `npm test` runs all tests.
- `npm run test:coverage` runs with v8 coverage.
- Coverage scoped to `lib/` only (CLI tested via subprocess, not instrumentable by v8).
- Thresholds: 90% statements, 80% branches, 95% functions, 90% lines.
- Tests use real SQLite (temp DB files in `os.tmpdir()`), never mocks.
- Each test creates its own temp dir via `WICKED_BUS_DATA_DIR` — fully isolated.

### Naming
- Package: `wicked-bus`
- CLI: `wicked-bus`
- Skills: `wicked-bus/{operation}` (e.g., `wicked-bus/init`)
- Skill directories: `skills/wicked-bus/{operation}/`
- Installer: `wicked-bus-install` (npm bin)

## Key Design Decisions

- **domain + subdomain** over `source_plugin`: domain is publisher identity, subdomain is functional area. Decided because `source_plugin` is a bad construct — it conflates identity with a specific technology concept.
- **Semantic event types**: `wicked.project.created` is shared across publishers. Domain scoping uses `@domain` filter suffix, not baked into the type string.
- **Two-timer TTL**: `dedup_expires_at` (24h) deletes rows, `expires_at` (72h) hides from poll. Deletion happens before invisibility by design.
- **WB-003 detection**: uses `MIN(event_id)` from ALL rows (no WHERE on expires_at). This catches the case where a cursor is behind swept events.
- **Fire-and-forget integration**: all integrations are non-blocking with hard timeouts (50ms Node.js, 100ms Python subprocess).

## Releasing

Releases are automated via GitHub Actions (`.github/workflows/release.yml`). **Never run `npm publish` locally** (except the initial package creation).

To release:
1. Commit and push changes to `main`
2. Tag and push: `git tag vX.Y.Z && git push --tags`

The pipeline:
- Tests on ubuntu, macos, windows
- Publishes to npm (with provenance)
- Publishes to GitHub Packages as `@mikeparcewski/wicked-bus`
- Creates a GitHub Release with auto-generated notes

The `package.json` version is set from the tag automatically.

## Data Directory

```
~/.something-wicked/wicked-bus/
  bus.db              # SQLite database (WAL mode)
  bus.db-wal          # WAL journal
  bus.db-shm          # Shared memory
  config.json         # Runtime configuration
```

Override location with `WICKED_BUS_DATA_DIR` env var.
