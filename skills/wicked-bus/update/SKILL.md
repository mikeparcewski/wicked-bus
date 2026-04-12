---
description: |
  Check for and install wicked-bus updates. Compares installed version against
  npm registry, updates skills across all detected CLIs.

  Use when: "update wicked-bus", "check for bus updates", "wicked-bus update",
  or periodically to stay current.
---

# wicked-bus:update

Check for and install updates to wicked-bus and its skills.

## Cross-Platform Notes

Commands work on macOS, Linux, and Windows. Use agent-native tools
(Read, Write, Grep, Glob) over shell commands when possible.

## When to use

- User asks to update or check for updates
- After encountering unexpected behavior that might be fixed in a newer version
- Periodically (suggest checking monthly)

## Process

### Step 1: Check current installed version

Check both global and local installations:

```bash
npm list -g wicked-bus --json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    deps = d.get('dependencies', {})
    v = deps.get('wicked-bus', {}).get('version', 'not installed')
    print(v)
except Exception:
    print('not installed')
" 2>/dev/null || python -c "
import json, sys
try:
    d = json.load(sys.stdin)
    deps = d.get('dependencies', {})
    v = deps.get('wicked-bus', {}).get('version', 'not installed')
    print(v)
except Exception:
    print('not installed')
"
```

Also check local (project-level) install:
```bash
npm list wicked-bus --json 2>/dev/null
```

### Step 2: Check latest version on npm

```bash
npm view wicked-bus version 2>/dev/null
```

### Step 3: Compare versions

If installed version matches latest:
"wicked-bus is up to date (v{version})."

If an update is available:
"wicked-bus v{new} is available (you have v{current}). Update now?"

### Step 4: Update (if user approves)

For global install:
```bash
npm install -g wicked-bus@latest 2>&1
```

For local (project) install:
```bash
npm install wicked-bus@latest 2>&1
```

If `EACCES` / permission denied:
- macOS/Linux: `sudo npm install -g wicked-bus@latest`
- Windows: re-run shell as Administrator
- Report the failure — do NOT silently skip

### Step 5: Refresh skills in all CLIs

After updating the package, run the installer to copy updated skills:

```bash
npx wicked-bus-install
```

Or with a specific CLI target:
```bash
npx wicked-bus-install --cli=claude
```

### Step 6: Verify

Re-run the Step 1 version check. Confirm the version matches latest.

If it still shows the old version:
1. Check `which wicked-bus` (macOS/Linux) or `where wicked-bus` (Windows)
2. Clear npm cache: `npm cache clean --force`
3. Check if nvm/fnm/volta is pinning a stale copy

### Step 7: Report

```
wicked-bus updated: v{old} → v{new}
Skills refreshed in {N} CLIs: {list}
```

## Version check without updating

If the user just wants to check, stop after Step 3 and report
current vs. available version.
