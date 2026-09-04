import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, writeDefaultConfig, DEFAULTS } from '../../lib/config.js';

describe('config', () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-config-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.WICKED_BUS_DATA_DIR = originalEnv;
    } else {
      delete process.env.WICKED_BUS_DATA_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('returns defaults when no config.json exists', () => {
    const config = loadConfig();
    expect(config.ttl_hours).toBe(72);
    expect(config.dedup_ttl_hours).toBe(24);
    expect(config.sweep_interval_minutes).toBe(15);
    expect(config.archive_mode).toBe(false);
    expect(config.log_level).toBe('warn');
    expect(config.db_path).toBeNull();
    expect(config.max_payload_bytes).toBe(1048576);
  });

  it('merges user config with defaults', () => {
    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({ ttl_hours: 48, log_level: 'debug' })
    );
    const config = loadConfig();
    expect(config.ttl_hours).toBe(48);
    expect(config.log_level).toBe('debug');
    expect(config.dedup_ttl_hours).toBe(24); // default
  });

  it('ignores malformed config.json', () => {
    writeFileSync(join(tmpDir, 'config.json'), '{ not valid json');
    const config = loadConfig();
    expect(config.ttl_hours).toBe(72);
  });

  it('throws when dedup_ttl_hours > ttl_hours', () => {
    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({ dedup_ttl_hours: 100, ttl_hours: 72 })
    );
    expect(() => loadConfig()).toThrow(/dedup_ttl_hours/);
  });

  it('throws when sweep_interval_minutes < 0', () => {
    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({ sweep_interval_minutes: -1 })
    );
    expect(() => loadConfig()).toThrow(/sweep_interval_minutes/);
  });

  it('throws when max_payload_bytes < 1', () => {
    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({ max_payload_bytes: 0 })
    );
    expect(() => loadConfig()).toThrow(/max_payload_bytes/);
  });

  it('throws on invalid log_level', () => {
    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({ log_level: 'verbose' })
    );
    expect(() => loadConfig()).toThrow(/log_level/);
  });

  it('applies CLI overrides', () => {
    const config = loadConfig({ db_path: '/custom/path.db', log_level: 'error' });
    expect(config.db_path).toBe('/custom/path.db');
    expect(config.log_level).toBe('error');
  });

  it('writeDefaultConfig creates config.json with defaults', () => {
    writeDefaultConfig(tmpDir);
    const { readFileSync } = require('node:fs');
    const written = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf8'));
    expect(written).toEqual(DEFAULTS);
  });

  it('writeDefaultConfig does not overwrite existing unless force', () => {
    writeFileSync(join(tmpDir, 'config.json'), '{"ttl_hours": 99}');
    writeDefaultConfig(tmpDir);
    const { readFileSync } = require('node:fs');
    const content = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf8'));
    expect(content.ttl_hours).toBe(99);
  });

  it('writeDefaultConfig overwrites when force=true', () => {
    writeFileSync(join(tmpDir, 'config.json'), '{"ttl_hours": 99}');
    writeDefaultConfig(tmpDir, true);
    const { readFileSync } = require('node:fs');
    const content = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf8'));
    expect(content.ttl_hours).toBe(72);
  });

  describe('interval key coercion', () => {
    const KEYS = [
      { key: 'sweep_interval_minutes', fallback: DEFAULTS.sweep_interval_minutes },
      { key: 'checkpoint_interval_minutes', fallback: DEFAULTS.checkpoint_interval_minutes },
    ];

    for (const { key, fallback } of KEYS) {
      describe(key, () => {
        it('coerces a numeric string to a number', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: '5' }));
          const config = loadConfig();
          expect(config[key]).toBe(5);
          expect(typeof config[key]).toBe('number');
        });

        it('falls back to the default on a garbage string', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: 'abc' }));
          const config = loadConfig();
          expect(config[key]).toBe(fallback);
          expect(typeof config[key]).toBe('number');
        });

        it.each([NaN, Infinity, -Infinity])(
          'falls back to the default on a non-finite numeric override',
          (value) => {
            const config = loadConfig({ [key]: value });
            expect(config[key]).toBe(fallback);
            expect(typeof config[key]).toBe('number');
          },
        );

        it('throws on a negative number', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: -1 }));
          expect(() => loadConfig()).toThrow(new RegExp(key));
        });

        it('throws on a negative numeric string (coerced before validation)', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: '-1' }));
          expect(() => loadConfig()).toThrow(new RegExp(key));
        });

        it('preserves a legitimate 0 (number)', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: 0 }));
          const config = loadConfig();
          expect(config[key]).toBe(0);
          expect(typeof config[key]).toBe('number');
        });

        it('preserves a legitimate "0" (string)', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: '0' }));
          const config = loadConfig();
          expect(config[key]).toBe(0);
          expect(typeof config[key]).toBe('number');
        });

        it('falls back to the default on an empty string', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: '' }));
          const config = loadConfig();
          expect(config[key]).toBe(fallback);
          expect(typeof config[key]).toBe('number');
        });

        it('falls back to the default on boolean true (not 1)', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: true }));
          const config = loadConfig();
          expect(config[key]).toBe(fallback);
          expect(typeof config[key]).toBe('number');
        });

        it('falls back to the default on boolean false (not 0)', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ [key]: false }));
          const config = loadConfig();
          expect(config[key]).toBe(fallback);
          expect(typeof config[key]).toBe('number');
        });

        it('falls back to the default when the key is absent', () => {
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({}));
          const config = loadConfig();
          expect(config[key]).toBe(fallback);
          expect(typeof config[key]).toBe('number');
        });

        it('falls back to the default when config.json is absent', () => {
          const config = loadConfig();
          expect(config[key]).toBe(fallback);
          expect(typeof config[key]).toBe('number');
        });
      });
    }
  });
});
