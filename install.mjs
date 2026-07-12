#!/usr/bin/env node
// wicked-bus installer — detects CLIs and installs skills

import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const skillsSource = join(__dirname, "skills");
const home = homedir();

// Claude-root candidate builder. Mirrors the 1.1.1 wicked-testing /
// wicked-brain fix: $CLAUDE_CONFIG_DIR is authoritative when set;
// otherwise probe common alt-config layouts. Claude Code's config root
// is redirectable, and hardcoded ~/.claude silently misses users on
// shared-home / multi-tenant setups.
function buildClaudeTarget(rootDir, source, { trusted = false } = {}) {
  return {
    name: "claude",
    rootDir,
    dir: join(rootDir, "skills"),
    platform: "claude",
    identityMarkers: ["settings.json", "plugins", "projects"],
    source,
    trusted,
  };
}

function resolveClaudeCandidates() {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && typeof envDir === "string" && envDir.trim()) {
    // Function replacement avoids `$&` etc. being interpreted as regex
    // back-references if $HOME contains those literals.
    const root = resolve(envDir.trim().replace(/^~/, () => home));
    return [buildClaudeTarget(root, "env:CLAUDE_CONFIG_DIR", { trusted: true })];
  }
  return [
    buildClaudeTarget(join(home, ".claude"),                "default"),
    buildClaudeTarget(join(home, "alt-configs", ".claude"), "alt-configs"),
    buildClaudeTarget(join(home, ".config", "claude"),      "xdg"),
  ];
}

function claudeHasIdentityMarker(target) {
  if (target.trusted) return true;
  if (!existsSync(target.rootDir)) return false;
  return (target.identityMarkers || []).some(m => existsSync(join(target.rootDir, m)));
}

// Non-claude canonical targets. Claude is expanded dynamically above.
const CLI_TARGETS = [
  { name: "gemini",      dir: join(home, ".gemini", "skills"),      platform: "gemini" },
  { name: "copilot",     dir: join(home, ".github", "skills"),      platform: "copilot" },
  { name: "codex",       dir: join(home, ".codex", "skills"),       platform: "codex" },
  { name: "cursor",      dir: join(home, ".cursor", "skills"),      platform: "cursor" },
  { name: "kiro",        dir: join(home, ".kiro", "skills"),        platform: "kiro" },
  { name: "antigravity", dir: join(home, ".antigravity", "skills"), platform: "antigravity" },
];

console.log("wicked-bus installer\n");

const args = argv.slice(2);

// Flag parser supporting both --flag=value and --flag value forms, plus
// narrow string-boolean coercion ("true" / "false" → booleans). Previously
// the ad-hoc parser silently dropped space-separated values — same bug
// that hit wicked-testing 0.3.2 / wicked-brain 0.3.7.
const flagValue = (name) => {
  const f = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  let val;
  if (f.includes("=")) {
    // slice from the first '=' forward — split("=")[1] would truncate at
    // the second '=' (e.g. --path=/volumes/build=artifacts).
    val = f.slice(f.indexOf("=") + 1);
  } else {
    const idx = args.indexOf(f);
    const next = args[idx + 1];
    val = (next && !next.startsWith("-")) ? next : true;
  }
  if (val === "false") return false;
  if (val === "true")  return true;
  return val;
};

const cliArg  = flagValue("cli");
const pathArg = flagValue("path");

// Validate --cli upfront so a mistyped --cli / --cli= fails fast
// instead of silently falling through to "all detected".
if (cliArg === true || cliArg === "") {
  console.error("Error: --cli requires a value (e.g. --cli=claude or --cli claude)");
  process.exit(1);
}

let targets;

if (pathArg && typeof pathArg === "string" && pathArg !== "") {
  const customPath = resolve(pathArg.replace(/^~/, () => home));
  const dirName = basename(customPath).replace(/^\./, "");
  targets = [{
    name: dirName,
    dir: join(customPath, "skills"),
    platform: dirName,
  }];
  console.log(`Custom path: ${customPath}\n`);
} else if (pathArg === true || pathArg === "") {
  console.error("Error: --path requires a value (e.g. --path=~/.claude or --path ~/.claude)");
  process.exit(1);
} else {
  // Expanded detection: claude candidates (env var OR alt-config probes,
  // identity-marker gated) + non-claude parent-dir-exists heuristic.
  const claudeDetected = resolveClaudeCandidates().filter(claudeHasIdentityMarker);
  const otherDetected  = CLI_TARGETS.filter((t) => existsSync(resolve(t.dir, "..")));
  const detected = [...claudeDetected, ...otherDetected];

  if (detected.length === 0) {
    console.log("No supported AI CLIs detected. Supported: claude, gemini, copilot, codex, cursor, kiro, antigravity");
    console.log("Install skills manually by copying the skills/ directory, or set CLAUDE_CONFIG_DIR.");
    process.exit(1);
  }

  const claudeCount = claudeDetected.length;
  const label = (d) => d.name === "claude" && claudeCount > 1 && d.source
    ? `${d.name}[${d.source}]`
    : d.name;
  console.log(`Detected CLIs: ${detected.map(label).join(", ")}\n`);

  const cliFilter = (typeof cliArg === "string" && cliArg !== "") ? cliArg.split(",") : null;
  targets = cliFilter ? detected.filter((d) => cliFilter.includes(d.name)) : detected;
}

// Copy skills to each target CLI
// Repo structure: skills/wicked-bus/{op}/SKILL.md (nested namespace)
// Installed structure: {cli}/skills/wicked-bus-{op}/SKILL.md (flat, one level deep)
// CLI skill discovery only scans one level deep under the skills directory.
const namespace = "wicked-bus";
const namespaceSrc = join(skillsSource, namespace);
const subSkills = readdirSync(namespaceSrc).filter((d) => !d.startsWith("."));

// Source SKILL.md frontmatter carries a BARE `name:` (e.g. `emit`). The
// installer owns namespacing, deriving the per-CLI skill id from that bare
// name. Every CLI we support installs skills as directory-based entries where
// the skill id must equal the installed directory basename — so the id must be
// COLON-FREE (a ':' would either be rewritten to '-' by Antigravity/Codex/etc.,
// reintroducing a name/dir mismatch, or is simply invalid as a directory name).
// Hence `wicked-bus-<op>` for all targets. Claude Code resolves these as
// personal skills by that same directory name; if wicked-bus were ever shipped
// as a Claude *plugin* (with a plugin.json), the plugin:skill colon form would
// be derived from the identical bare name — the bare name is the single source
// of truth either way.
function namespacedSkillName(bareName /*, platform */) {
  return `${namespace}-${bareName}`;
}

// Rewrite the copied SKILL.md `name:` frontmatter from the bare source name to
// the namespaced id so it matches the installed directory basename. Without
// this, discovery sees `name: emit` inside `wicked-bus-emit/` — a mismatch that
// collides across products and can prevent the skill from loading.
function stampSkillName(destSkillDir, installedName) {
  const skillMd = join(destSkillDir, "SKILL.md");
  if (!existsSync(skillMd)) return;
  const original = readFileSync(skillMd, "utf8");
  // Scope the rewrite to the `name:` INSIDE the leading YAML frontmatter block
  // (between the opening `---` and its closing `---`) — never a `name:` that
  // appears later in the doc body (an example snippet or table row). Only an
  // inline scalar is matched; a `|`/`>` block scalar is excluded. Uses a
  // replacement FUNCTION so an installedName containing `$` can't be read as a
  // `$&`/`$1` special pattern.
  const fm = original.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*\r?\n?)/);
  if (!fm) return;
  const [, open, body, close] = fm;
  const newBody = body.replace(/^name:[ \t]*(?![|>])\S.*$/m, () => `name: ${installedName}`);
  if (newBody === body) return;
  const rewritten = open + newBody + close + original.slice(fm[0].length);
  writeFileSync(skillMd, rewritten);
}

for (const target of targets) {
  console.log(`Installing to ${target.name} (${target.dir})...`);
  mkdirSync(target.dir, { recursive: true });

  for (const skill of subSkills) {
    const src = join(namespaceSrc, skill);
    const installedName = namespacedSkillName(skill, target.platform);
    const dest = join(target.dir, installedName);
    cpSync(src, dest, { recursive: true });
    stampSkillName(dest, installedName);
  }

  console.log(`  ${subSkills.length} skills installed`);
}

console.log(`\nwicked-bus skills installed! Available skills:`);
console.log(`  wicked-bus-init      — Initialize or connect to the bus`);
console.log(`  wicked-bus-emit      — Publish events`);
console.log(`  wicked-bus-subscribe — Consume events`);
console.log(`  wicked-bus-naming    — Event naming conventions`);
console.log(`  wicked-bus-query     — Query and debug the bus`);
console.log(`  wicked-bus-status    — Bus health and diagnostics`);
console.log(`  wicked-bus-update    — Check for and install updates`);
