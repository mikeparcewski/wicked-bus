---
description: Initialize wicked-bus or connect to an existing instance. Use when setting up the bus for the first time, checking if it's running, or configuring a project to use it. Auto-triggered when any wicked-bus skill detects no config.
---

# wicked-bus:init

Set up wicked-bus for the current project. Detects an existing running instance
before creating a new one.

## When to use

- First time using wicked-bus in a project
- Another wicked-bus skill detected no config and redirected here
- User asks to "set up the bus", "init wicked-bus", or "connect to the bus"

## Process

### Step 1: Check for existing instance

Before creating anything, check if wicked-bus is already initialized:

```bash
# Check if the data directory exists
ls ~/.something-wicked/wicked-bus/bus.db 2>/dev/null
```

If the data dir and DB exist, wicked-bus is already running. Skip to Step 4.

Also check if another agent or process already initialized it this session:

```bash
# Check if the CLI is available
npx wicked-bus status 2>/dev/null
```

If status returns valid JSON, the bus is live. Report to the user and skip init.

### Step 2: Check if wicked-bus is installed

```bash
# Check if the package is available
node -e "require.resolve('wicked-bus')" 2>/dev/null || \
  node -e "import('wicked-bus').then(() => console.log('found'))" 2>/dev/null
```

If not installed:
```
wicked-bus is not installed. Install it:
  npm install wicked-bus
```

### Step 3: Initialize

Run the init command:

```bash
npx wicked-bus init
```

This creates:
- `~/.something-wicked/wicked-bus/` data directory
- `bus.db` SQLite database with WAL mode
- `config.json` with defaults

Verify success by checking the JSON output for `"initialized": true`.

### Step 4: Register the current project (optional)

If the user wants this project to emit events, register as a provider:

Ask: "What domain name should this project use?" (default: directory name)

```bash
npx wicked-bus register \
  --role provider \
  --plugin {domain} \
  --filter 'wicked.*'
```

### Step 5: Confirm

Report:
```
wicked-bus is ready.
  Data dir: ~/.something-wicked/wicked-bus/
  DB: bus.db (WAL mode)
  Status: {event count} events, {subscriber count} subscribers
```

If the bus was already running, say so:
```
wicked-bus is already initialized and running.
  {status output}
```
