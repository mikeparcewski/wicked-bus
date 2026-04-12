import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: register', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-reg-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('registers a provider', () => {
    const result = run([
      'register',
      '--role', 'provider',
      '--plugin', 'wicked-testing',
      '--events', 'wicked.test.run.completed',
      '--schema-version', '1.0.0',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.subscription_id).toBeTruthy();
    expect(output.role).toBe('provider');
    expect(existsSync(join(tmpDir, 'providers', 'wicked-testing.json'))).toBe(true);
  });

  it('registers a subscriber with cursor', () => {
    const result = run([
      'register',
      '--role', 'subscriber',
      '--plugin', 'test-consumer',
      '--filter', 'wicked.test.run.*',
      '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.subscription_id).toBeTruthy();
    expect(output.cursor_id).toBeTruthy();
    expect(output.last_event_id).toBe(0);
  });
});
