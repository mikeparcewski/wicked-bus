import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';

describe('paths', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  async function loadPaths() {
    // Force re-import to pick up env changes
    return await import('../../lib/paths.js');
  }

  it('resolveDataDir uses WICKED_BUS_DATA_DIR when set', async () => {
    process.env.WICKED_BUS_DATA_DIR = '/custom/path';
    const { resolveDataDir } = await loadPaths();
    expect(resolveDataDir()).toBe('/custom/path');
  });

  it('resolveDataDir uses home directory when WICKED_BUS_DATA_DIR is not set', async () => {
    delete process.env.WICKED_BUS_DATA_DIR;
    // On Windows, APPDATA or USERPROFILE take priority over HOME
    // so we clear those too to test the HOME fallback
    const savedAppData = process.env.APPDATA;
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.APPDATA;
    delete process.env.USERPROFILE;
    process.env.HOME = '/home/testuser';
    const { resolveDataDir } = await loadPaths();
    const result = resolveDataDir();
    expect(result).toBe(join('/home/testuser', '.something-wicked', 'wicked-bus'));
    // Restore
    if (savedAppData) process.env.APPDATA = savedAppData;
    if (savedUserProfile) process.env.USERPROFILE = savedUserProfile;
  });

  it('resolveDbPath uses config.db_path when set', async () => {
    process.env.WICKED_BUS_DATA_DIR = '/data';
    const { resolveDbPath } = await loadPaths();
    expect(resolveDbPath({ db_path: '/custom/bus.db' })).toBe('/custom/bus.db');
  });

  it('resolveDbPath defaults to <dataDir>/bus.db', async () => {
    process.env.WICKED_BUS_DATA_DIR = '/data';
    const { resolveDbPath } = await loadPaths();
    expect(resolveDbPath({})).toBe(join('/data', 'bus.db'));
  });

  it('resolveDataDir falls back to homedir() when HOME is not set', async () => {
    delete process.env.WICKED_BUS_DATA_DIR;
    delete process.env.HOME;
    // homedir() should still work even without HOME env var
    const { resolveDataDir } = await loadPaths();
    const result = resolveDataDir();
    // Should return something (homedir fallback)
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('ensureDataDir creates the directory', async () => {
    const { mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    const dir = join(tmpdir(), 'wb-test-' + randomUUID());
    process.env.WICKED_BUS_DATA_DIR = dir;
    const { ensureDataDir } = await loadPaths();
    const result = ensureDataDir();
    expect(result).toBe(dir);
    // Verify directory exists
    const { existsSync } = await import('node:fs');
    expect(existsSync(dir)).toBe(true);
    // Cleanup
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });
});
