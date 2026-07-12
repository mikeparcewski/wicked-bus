import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: deregister', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-dereg-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('deregisters a subscription', () => {
    // Register first
    const regResult = run([
      'register',
      '--role', 'subscriber',
      '--plugin', 'test-consumer',
      '--filter', 'wicked.test.*',
      '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });
    const { subscription_id } = JSON.parse(regResult.stdout.trim());

    // Deregister
    const result = run([
      'deregister',
      '--subscription-id', subscription_id,
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.deregistered).toBe(true);
    expect(output.subscription_id).toBe(subscription_id);
  });

  it('deregisters by --plugin without needing the subscription-id', () => {
    run([
      'register', '--role', 'subscriber', '--plugin', 'wi-agent',
      '--filter', 'wicked.test.*', '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });
    run([
      'register', '--role', 'subscriber', '--plugin', 'wi-agent',
      '--filter', 'wicked.crew.*', '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });

    const result = run(['deregister', '--plugin', 'wi-agent'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.deregistered).toBe(true);
    expect(output.plugin).toBe('wi-agent');
    expect(output.count).toBe(2);

    // Both are gone: a re-deregister finds nothing active → WB-006.
    const again = run(['deregister', '--plugin', 'wi-agent'], { dataDir: tmpDir });
    expect(again.exitCode).not.toBe(0);
    expect(JSON.parse(again.stderr.trim()).error).toBe('WB-006');
  });

  it('requires --subscription-id or --plugin', () => {
    const result = run(['deregister'], { dataDir: tmpDir });
    expect(result.exitCode).not.toBe(0);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error).toBe('WB-001');
    expect(err.message).toMatch(/--subscription-id or --plugin/);
  });
});
