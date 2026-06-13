/**
 * Cross-platform atomic-rename helper tests.
 *
 * Covers:
 *   - overwrite/rename-over-existing path (passes on POSIX where rename
 *     overwrites atomically; the point is correctness + a regression guard)
 *   - tmp cleanup on unrecoverable failure
 *   - swallowCodes (EEXIST no-op race used by the CAS)
 *   - the win32 fallback branch, exercised by mocking process.platform + fs so
 *     it runs on every OS
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicRename } from '../../lib/atomic.js';

describe('atomic — atomicRename (real fs, current platform)', () => {
  let dir;

  beforeEach(() => {
    dir = join(tmpdir(), 'wb-atomic-' + randomUUID());
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  it('renames tmp into a fresh (non-existing) target', () => {
    const tmp = join(dir, 'a.tmp');
    const target = join(dir, 'a');
    fs.writeFileSync(tmp, 'new');

    atomicRename(tmp, target);

    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('overwrites an EXISTING target (rename-over-existing path)', () => {
    const tmp = join(dir, 'b.tmp');
    const target = join(dir, 'b');
    fs.writeFileSync(target, 'old');     // destination already exists
    fs.writeFileSync(tmp, 'new');

    atomicRename(tmp, target);

    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');   // overwritten
  });

  it('cleans up the tmp file and rethrows on an unrecoverable error', () => {
    // Source does not exist → renameSync throws ENOENT (not a win32 overwrite
    // code) → helper rethrows after attempting cleanup.
    const tmp = join(dir, 'does-not-exist.tmp');
    const target = join(dir, 'c');
    expect(() => atomicRename(tmp, target)).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('swallowCodes lets a swallowed error pass without throwing', () => {
    // Force an ENOENT (source missing) but mark it swallowable. Should not throw.
    const tmp = join(dir, 'missing.tmp');
    const target = join(dir, 'd');
    expect(() => atomicRename(tmp, target, { swallowCodes: ['ENOENT'] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// win32 branch — mock process.platform + fs so the Windows-specific
// unlink-then-rename fallback runs on macOS/Linux CI.
// ---------------------------------------------------------------------------

describe('atomic — atomicRename win32 fallback (mocked platform)', () => {
  let originalPlatform;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    vi.restoreAllMocks();
  });

  it('on EPERM: unlinks the destination then re-renames (win32 overwrite)', () => {
    const calls = [];
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      calls.push('rename');
      // First rename fails as Windows would for an existing target; the
      // post-unlink rename succeeds.
      if (calls.filter((c) => c === 'rename').length === 1) {
        const err = new Error('EPERM: operation not permitted, rename');
        err.code = 'EPERM';
        throw err;
      }
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { calls.push('unlink'); });

    expect(() => atomicRename('x.tmp', 'x')).not.toThrow();

    // rename → (EPERM) → unlink(dest) → rename(success)
    expect(calls).toEqual(['rename', 'unlink', 'rename']);
    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(unlinkSpy).toHaveBeenCalledWith('x');           // destination unlinked
  });

  it('on transient EBUSY: retries the rename and eventually succeeds', () => {
    let renameAttempts = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      renameAttempts++;
      // 1st (initial) + 2nd (post-unlink) fail with EBUSY, 3rd succeeds.
      if (renameAttempts < 3) {
        const err = new Error('EBUSY: resource busy or locked, rename');
        err.code = 'EBUSY';
        throw err;
      }
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    expect(() => atomicRename('y.tmp', 'y')).not.toThrow();
    expect(renameAttempts).toBeGreaterThanOrEqual(3);
  });

  it('on persistent failure: cleans up tmp and rethrows', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('EACCES: permission denied, rename');
      err.code = 'EACCES';
      throw err;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    expect(() => atomicRename('z.tmp', 'z')).toThrow(/EACCES/);
    // tmp cleanup attempted on the final failure path
    expect(unlinkSpy).toHaveBeenCalledWith('z.tmp');
  });
});
