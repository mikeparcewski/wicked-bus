/**
 * Cross-platform atomic file placement helpers.
 *
 * POSIX `rename(2)` atomically replaces an existing destination. Windows
 * `MoveFileEx`-backed `fs.rename` REJECTS a rename onto an existing file with
 * `EPERM` / `EEXIST` / `EACCES`, and may transiently fail with `EBUSY` when the
 * destination (or a directory entry) is briefly held open by AV/indexer/another
 * handle. POSIX never sees these for an overwrite.
 *
 * This module centralizes the cross-platform fallback so every "write to a temp
 * file, then rename it into final position" site behaves identically and can't
 * regress independently.
 *
 * @module lib/atomic
 */

import fs from 'node:fs';

// Number of times we retry a transient EBUSY on win32 before giving up, and the
// backoff between attempts. Kept tiny — EBUSY here is from a momentary handle
// (AV scan / indexer), not sustained contention. Synchronous spin-wait so the
// helper stays drop-in for the existing synchronous CAS/fs codepaths.
const WIN32_EBUSY_RETRIES = 5;
const WIN32_EBUSY_BACKOFF_MS = 20;

function sleepSync(ms) {
  // Busy-ish wait without pulling in a dependency. Used only on the win32 EBUSY
  // retry path, which is rare and short.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/**
 * Rename `tmp` onto `target`, overwriting any existing `target` atomically.
 *
 * On POSIX a single `renameSync` already overwrites atomically. On win32, if the
 * rename is rejected because `target` exists (EPERM/EEXIST/EACCES) we unlink the
 * destination then retry the rename; a transient EBUSY is retried with a short
 * backoff. On any unrecoverable failure the `tmp` file is cleaned up before the
 * error is rethrown so we never leak partial temp files.
 *
 * @param {string} tmp     path to the fully-written temp file
 * @param {string} target  final destination path
 * @param {object} [opts]
 * @param {string[]} [opts.swallowCodes]  on POSIX-or-win32, rethrow is skipped
 *                                         for these error codes (e.g. ['EEXIST']
 *                                         for content-addressed no-op races). The
 *                                         tmp file is still cleaned up.
 */
export function atomicRename(tmp, target, opts = {}) {
  const swallow = new Set(opts.swallowCodes ?? []);
  const isWin = process.platform === 'win32';

  try {
    fs.renameSync(tmp, target);
    return;
  } catch (e) {
    // win32: rename-over-existing is rejected. Unlink the destination and retry.
    if (isWin && (e.code === 'EPERM' || e.code === 'EEXIST' || e.code === 'EACCES' || e.code === 'EBUSY')) {
      let lastErr = e;
      for (let attempt = 0; attempt <= WIN32_EBUSY_RETRIES; attempt++) {
        try {
          // Remove the destination so the rename has a clear path. The
          // destination may legitimately not exist (pure EBUSY on the source),
          // so a failing unlink is non-fatal.
          try { fs.unlinkSync(target); } catch (_e) { /* may not exist */ }
          fs.renameSync(tmp, target);
          return;
        } catch (retryErr) {
          lastErr = retryErr;
          // Only EBUSY is worth retrying — it's the transient AV/indexer hold.
          if (retryErr.code === 'EBUSY' && attempt < WIN32_EBUSY_RETRIES) {
            sleepSync(WIN32_EBUSY_BACKOFF_MS);
            continue;
          }
          break;
        }
      }
      // Exhausted retries (or a non-EBUSY error on the fallback path).
      try { fs.unlinkSync(tmp); } catch (_e) { /* avoid leaking the temp file */ }
      if (swallow.has(lastErr.code)) return;
      throw lastErr;
    }

    // POSIX (or a win32 error we don't special-case). Clean up the temp file.
    try { fs.unlinkSync(tmp); } catch (_e) { /* avoid leaking the temp file */ }
    if (swallow.has(e.code)) return;
    throw e;
  }
}
