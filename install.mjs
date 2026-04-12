#!/usr/bin/env node
// wicked-bus installer — detects CLIs and installs skills

import { existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const skillsSource = join(__dirname, "skills");
const home = homedir();

const CLI_TARGETS = [
  { name: "claude",      dir: join(home, ".claude", "skills"),      platform: "claude" },
  { name: "gemini",      dir: join(home, ".gemini", "skills"),      platform: "gemini" },
  { name: "copilot",     dir: join(home, ".github", "skills"),      platform: "copilot" },
  { name: "codex",       dir: join(home, ".codex", "skills"),       platform: "codex" },
  { name: "cursor",      dir: join(home, ".cursor", "skills"),      platform: "cursor" },
  { name: "kiro",        dir: join(home, ".kiro", "skills"),        platform: "kiro" },
  { name: "antigravity", dir: join(home, ".antigravity", "skills"), platform: "antigravity" },
];

console.log("wicked-bus installer\n");

const args = argv.slice(2);
const argValue = (a) => a.split("=")[1];
const cliArg = args.find((a) => a.startsWith("--cli="));
const pathArg = args.find((a) => a.startsWith("--path="));

let targets;

if (pathArg) {
  const rawPath = argValue(pathArg);
  if (!rawPath) {
    console.error("Error: --path requires a value (e.g. --path=~/.claude)");
    process.exit(1);
  }
  const customPath = resolve(rawPath.replace(/^~/, home));
  const dirName = basename(customPath).replace(/^\./, "");
  targets = [{
    name: dirName,
    dir: join(customPath, "skills"),
    platform: dirName,
  }];
  console.log(`Custom path: ${customPath}\n`);
} else {
  const detected = CLI_TARGETS.filter((t) => existsSync(resolve(t.dir, "..")));

  if (detected.length === 0) {
    console.log("No supported AI CLIs detected. Supported: claude, gemini, copilot, codex, cursor, kiro, antigravity");
    console.log("Install skills manually by copying the skills/ directory.");
    process.exit(1);
  }

  console.log(`Detected CLIs: ${detected.map((d) => d.name).join(", ")}\n`);

  const cliFilter = cliArg ? argValue(cliArg).split(",") : null;
  targets = cliFilter ? detected.filter((d) => cliFilter.includes(d.name)) : detected;
}

// Copy skills to each target CLI
const skillDirs = readdirSync(skillsSource).filter((d) => !d.startsWith("."));

for (const target of targets) {
  console.log(`Installing to ${target.name} (${target.dir})...`);
  mkdirSync(target.dir, { recursive: true });

  for (const skill of skillDirs) {
    const src = join(skillsSource, skill);
    const dest = join(target.dir, skill);
    cpSync(src, dest, { recursive: true });
  }

  console.log(`  ${skillDirs.length} skills installed`);
}

console.log(`\nwicked-bus skills installed! Available skills:`);
console.log(`  wicked-bus-init      — Initialize or connect to the bus`);
console.log(`  wicked-bus-emit      — Publish events`);
console.log(`  wicked-bus-subscribe — Consume events`);
console.log(`  wicked-bus-naming    — Event naming conventions`);
console.log(`  wicked-bus-query     — Query and debug the bus`);
