import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: list', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-list-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('lists registrations as JSON', () => {
    // Register a provider
    run([
      'register', '--role', 'provider', '--plugin', 'wicked-testing',
      '--events', 'wicked.test.run.completed',
    ], { dataDir: tmpDir });

    const result = run(['list'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBe(1);
    expect(output[0].plugin).toBe('wicked-testing');
  });

  it('--role filters by role', () => {
    run(['register', '--role', 'provider', '--plugin', 'p1', '--events', 'e1'], { dataDir: tmpDir });
    run(['register', '--role', 'subscriber', '--plugin', 's1', '--filter', 'wicked.test.*', '--cursor-init', 'oldest'], { dataDir: tmpDir });

    const result = run(['list', '--role', 'provider'], { dataDir: tmpDir });
    const output = JSON.parse(result.stdout.trim());
    expect(output.length).toBe(1);
    expect(output[0].role).toBe('provider');
  });

  it('excludes deregistered by default', () => {
    const regResult = run([
      'register', '--role', 'provider', '--plugin', 'p1', '--events', 'e1',
    ], { dataDir: tmpDir });
    const { subscription_id } = JSON.parse(regResult.stdout.trim());
    run(['deregister', '--subscription-id', subscription_id], { dataDir: tmpDir });

    const result = run(['list'], { dataDir: tmpDir });
    const output = JSON.parse(result.stdout.trim());
    expect(output.length).toBe(0);
  });

  it('--include-deregistered shows deregistered records', () => {
    const regResult = run([
      'register', '--role', 'provider', '--plugin', 'p1', '--events', 'e1',
    ], { dataDir: tmpDir });
    const { subscription_id } = JSON.parse(regResult.stdout.trim());
    run(['deregister', '--subscription-id', subscription_id], { dataDir: tmpDir });

    const result = run(['list', '--include-deregistered'], { dataDir: tmpDir });
    const output = JSON.parse(result.stdout.trim());
    expect(output.length).toBe(1);
  });
});
