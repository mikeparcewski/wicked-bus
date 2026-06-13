import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
).version;

describe('CLI: global flags', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-global-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('--db-path overrides database location', () => {
    const customDb = join(tmpDir, 'custom.db');
    const result = run([
      'init', '--db-path', customDb,
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
  });

  it('--version prints the package version and exits 0', () => {
    const result = run(['--version'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(PKG_VERSION);
    // Must NOT be the usage/help JSON (the bug wicked-loom doctor tripped on).
    expect(result.stdout).not.toContain('usage');
    expect(result.stdout).not.toContain('commands');
  });

  it('-v is an alias for --version', () => {
    const result = run(['-v'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(PKG_VERSION);
  });

  it('--payload @file reads from file', () => {
    const payloadFile = join(tmpDir, 'payload.json');
    writeFileSync(payloadFile, '{"runId":"r1","status":"passed"}');

    const result = run([
      'emit',
      '--type', 'wicked.test.run.completed',
      '--domain', 'wicked-testing',
      '--payload', `@${payloadFile}`,
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.event_id).toBe(1);
  });
});
