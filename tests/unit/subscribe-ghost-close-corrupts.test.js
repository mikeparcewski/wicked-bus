/**
 * WB-014's remediation is load-bearing — pin the destructive alternative (wicked-crew F-E2E-021).
 *
 * Ghost state: a process holds open better-sqlite3 connections on bus.db whose -wal/-shm were unlinked
 * underneath them. How that happens: a SECOND SQLite library in the same process — Node's
 * `node:sqlite` — opened and closed a handle on the file; under POSIX advisory locking that close
 * released every lock the process held, so the next short-lived external emitter's close took the
 * EXCLUSIVE lock, checkpointed, and unlinked both sidecars. Subscribers polling on such connections
 * report WB-014 once their view diverges. The FILE is fine at that point — a fresh process reads it
 * and `integrity_check` says ok.
 *
 * What the remediation text must therefore never say is "reopen" / "close and reopen":
 *   - a graceful `close()` of the LAST ghost connection takes the EXCLUSIVE lock and checkpoints the
 *     GHOST WAL (stale page images, from the deleted -wal, with the stale page count) over a file
 *     other writers already advanced. The file is then either torn (`integrity_check` fails /
 *     `SQLITE_CORRUPT`) or silently REWOUND — truncated to the ghost page count, rows other processes
 *     had durably committed gone, while `integrity_check` still says ok. Both are data loss;
 *   - `process.exit` WITHOUT closing (the kernel drops the fds; no checkpoint-on-close) leaves the
 *     file intact, every externally committed row included.
 *
 * The ghost connections here are plain seam-like handles (one read each holds the WAL-mode SHARED
 * lock for life), deliberately WITHOUT poll loops: a poller that has already failed with
 * `SQLITE_CORRUPT` can leave a read-mark behind that makes the final checkpoint skip, which is
 * timing-dependent — the destructive path is the clean one (seams stopped, connections closed in
 * order, as a graceful shutdown would do). Both halves run in a CHILD process (this test process
 * never holds ghost handles); the external side is what `wicked-bus emit` does — a separate process
 * that opens, emits, closes (the close is the checkpoint). POSIX-only (Windows cannot unlink a file
 * with open handles), and it needs `node:sqlite`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

let hasNodeSqlite = false;
try {
  require('node:sqlite');
  hasNodeSqlite = true;
} catch {
  hasNodeSqlite = false;
}
const runHere = platform() !== 'win32' && hasNodeSqlite ? it : it.skip;

/** External emitter, one process: open → `count` emits → graceful close (= checkpoint-on-close). */
const EXTERNAL = String.raw`
import path from 'node:path';
const bus = await import(path.join(process.env.ROOT, 'lib/index.js'));
const db = bus.openDb({ db_path: path.join(process.env.WICKED_BUS_DATA_DIR, 'bus.db') });
const config = bus.loadConfig();
const from = Number(process.env.FROM), count = Number(process.env.COUNT);
for (let n = from; n < from + count; n++) {
  bus.emit(db, config, { event_type: 'wicked.estate.indexed', domain: 'wicked-estate', subdomain: 'estate.index',
    payload: { n, pad: 'y'.repeat(400) } });
}
db.close();
`;

/** A fresh process reads the file: row count + integrity_check + size, or the driver error code. */
const READER = String.raw`
const Database = require(process.env.BSQ);
let db = null;
try {
  db = new Database(process.env.DB, { readonly: true, fileMustExist: true });
  const c = db.prepare('SELECT count(*) AS c FROM events').get().c;
  const ic = db.pragma('integrity_check', { simple: true });
  console.log(JSON.stringify({ c, ic, size: require('node:fs').statSync(process.env.DB).size }));
} catch (err) {
  console.log(JSON.stringify({ err: err.code ?? String(err) }));
} finally {
  try { db?.close(); } catch {}
}
`;

/**
 * Child: build the ghost state (4 seam-like connections; unlink proven), advance the file from the
 * outside and from the ghost side, read the file from a fresh process, then either close every
 * connection gracefully (MODE=close) or exit without closing (MODE=exit).
 * Prints one JSON line: { unlinked, before, closed }.
 */
const CHILD = String.raw`
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ROOT = process.env.ROOT, MODE = process.env.MODE, busDir = process.env.WICKED_BUS_DATA_DIR;
const bus = await import(path.join(ROOT, 'lib/index.js'));
const dbPath = path.join(busDir, 'bus.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const config = bus.loadConfig();
const conns = [];
for (let i = 0; i < 4; i++) {
  const db = bus.openDb({ db_path: dbPath });
  db.prepare('SELECT count(*) AS c FROM events').get(); // first read: the WAL-mode SHARED lock is held from here on
  conns.push(db);
}
const daemonEmit = (n) => bus.emit(conns[0], config, { event_type: 'wicked.crew.repo.registered', domain: 'wicked-crew',
  subdomain: 'crew.repo', payload: { n, pad: 'x'.repeat(400) } });
const external = (from, count) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', process.env.EXTERNAL],
    { encoding: 'utf8', env: { ...process.env, FROM: String(from), COUNT: String(count) } });
  if (r.status !== 0) throw new Error('external emitter failed: ' + r.stderr);
};
const freshRead = () => {
  const r = spawnSync(process.execPath, ['-e', process.env.READER],
    { encoding: 'utf8', env: { ...process.env, DB: dbPath, BSQ: path.join(ROOT, 'node_modules', 'better-sqlite3') } });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { err: 'reader failed: ' + r.stderr }; }
};
const sidecars = () => ({ wal: fs.existsSync(dbPath + '-wal'), shm: fs.existsSync(dbPath + '-shm') });
daemonEmit(1); daemonEmit(2);
external(1, 3); // control: our SHARED locks keep this close from unlinking anything
const control = sidecars();
// The second SQLite library on the same file: open, read, close (crew's old activity-feed read).
const { DatabaseSync } = require('node:sqlite');
const ro = new DatabaseSync(dbPath, { readOnly: true });
ro.prepare('SELECT count(*) c FROM events').get();
ro.close();
external(100, 1); // this process's close now unlinks -wal/-shm under our 4 open connections
const afterUnlink = sidecars();
const unlinked = control.wal && control.shm && !afterUnlink.wal && !afterUnlink.shm;
// Advance the file on both sides: ghost frames from our writer, real frames + checkpoints from outside.
for (let r = 0; r < 2; r++) {
  daemonEmit(200 + r * 3); daemonEmit(201 + r * 3); daemonEmit(202 + r * 3);
  external(300 + r * 25, 25);
  await sleep(150);
}
const before = freshRead(); // what every OTHER process durably sees right now
if (MODE === 'exit') {
  console.log(JSON.stringify({ unlinked, before, closed: false }));
  process.exit(0); // WITHOUT close(): the kernel drops the fds, no checkpoint-on-close
}
for (const c of conns) c.close(); // graceful close; the LAST one checkpoints the GHOST WAL into bus.db
console.log(JSON.stringify({ unlinked, before, closed: true }));
`;

function runChild(mode, busDir) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    encoding: 'utf8',
    env: { ...process.env, ROOT: REPO_ROOT, MODE: mode, WICKED_BUS_DATA_DIR: busDir, EXTERNAL, READER },
    timeout: 120_000,
  });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '';
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  return { status: r.status, signal: r.signal, stderr: r.stderr, parsed };
}

/** Judge the file from THIS process (which never opened it): count + integrity_check, or the error code. */
function judge(dbPath) {
  const Database = require('better-sqlite3');
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const c = db.prepare('SELECT count(*) AS c FROM events').get().c;
    const ic = db.pragma('integrity_check', { simple: true });
    return { c, ic };
  } catch (err) {
    return { err: err.code ?? String(err) };
  } finally {
    try { db?.close(); } catch { /* judged already */ }
  }
}

describe('WB-014 remediation — ghost connections vs. graceful close (POSIX)', () => {
  runHere('a graceful close() of the last ghost connection checkpoints the ghost WAL into bus.db: the file is torn or silently rewound (committed rows lost)', () => {
    const busDir = join(tmpdir(), 'wb-ghost-close-' + randomUUID());
    mkdirSync(busDir, { recursive: true });
    try {
      const child = runChild('close', busDir);
      expect(child.status, `child failed (signal ${child.signal}): ${child.stderr}`).toBe(0);
      expect(child.parsed, `child printed no verdict: ${child.stderr}`).not.toBeNull();
      expect(child.parsed.unlinked, 'the ghost state must be real: sidecars present after the control emit, gone after the post-node:sqlite emit, with 4 connections open').toBe(true);
      expect(child.parsed.closed).toBe(true);
      // Right before the close the file was fine for everyone else…
      const before = child.parsed.before;
      expect(before.ic, `expected an intact file before the close, got ${JSON.stringify(before)}`).toBe('ok');
      expect(before.c).toBeGreaterThan(0);
      // …and after the last graceful close it is either torn or rewound behind what others had committed.
      const after = judge(join(busDir, 'bus.db'));
      const torn = after.err === 'SQLITE_CORRUPT' || (after.ic !== undefined && after.ic !== 'ok');
      const rewound = typeof after.c === 'number' && after.c < before.c;
      expect(
        torn || rewound,
        `expected the last graceful close to damage the store (torn or rewound); before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      ).toBe(true);
    } finally {
      rmSync(busDir, { recursive: true, force: true });
    }
  }, 150_000);

  runHere('exiting WITHOUT closing the ghost connections leaves bus.db intact, every committed row included — the remediation WB-014 prescribes', () => {
    const busDir = join(tmpdir(), 'wb-ghost-exit-' + randomUUID());
    mkdirSync(busDir, { recursive: true });
    try {
      const child = runChild('exit', busDir);
      expect(child.status, `child failed (signal ${child.signal}): ${child.stderr}`).toBe(0);
      expect(child.parsed, `child printed no verdict: ${child.stderr}`).not.toBeNull();
      expect(child.parsed.unlinked, 'the ghost state must be real (sidecars unlinked under 4 open connections)').toBe(true);
      expect(child.parsed.closed).toBe(false);
      const before = child.parsed.before;
      expect(before.ic).toBe('ok');
      const after = judge(join(busDir, 'bus.db'));
      expect(after.ic, `expected an intact file after exit-without-close, got ${JSON.stringify(after)}`).toBe('ok');
      expect(after.c, 'no committed row may be lost by exiting without close').toBe(before.c);
      expect(existsSync(join(busDir, 'bus.db'))).toBe(true);
    } finally {
      rmSync(busDir, { recursive: true, force: true });
    }
  }, 150_000);
});
