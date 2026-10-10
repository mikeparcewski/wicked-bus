/**
 * Retention, tier, commit-boundary and DLQ/CAS invariants at the real entry
 * points (codex foundation audit 2026-10-09):
 *
 *   FND-BUS-01 (#101)  the sweep never drops an event before its lifetime
 *                      (`expires_at`), keeps expired events an active cursor
 *                      still owes under the default `unacked_policy: 'retain'`
 *                      (archive / discard are explicit and reported), and the
 *                      dedup window is separate from event retention.
 *   FND-BUS-02 (#102)  `wicked-bus cleanup --tiered` (config `tiered_archive`)
 *                      writes monthly warm buckets that queries read
 *                      transparently; the default CLI cleanup stays in-db.
 *   FND-BUS-03 (#103)  a failed (disk-full) insert throws WB-004 and leaves no
 *                      row: nothing was accepted.
 *   FND-BUS-04 (#104)  CAS GC keeps a blob a dead-letter row still references
 *                      after its event is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { poll, ack } from '../../lib/poll.js';
import { register } from '../../lib/register.js';
import { runSweep } from '../../lib/sweep.js';
import { archiveDir, listBuckets } from '../../lib/archive.js';
import { pollResolve } from '../../lib/query.js';
import { gc as casGc, exists as casExists, get as casGet } from '../../lib/cas.js';
import { WBError } from '../../lib/errors.js';
import { run } from '../cli/helpers.js';

const HOUR = 3_600_000;

describe('FND-BUS retention / tiers / commit boundary / DLQ-CAS', () => {
  let tmpDir, db, config, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-retention-policy-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = { ...loadConfig(), daemon_notify: false, log_level: 'silent' };
    db = openDb(config);
  });

  afterEach(() => {
    try { db.close(); } catch (_) { /* already closed */ }
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  /** Register a subscriber whose cursor starts before everything (offline consumer). */
  function subscriber(filter = 'wicked.review.fixture.*') {
    const sub = register(db, { plugin: 'p-' + randomUUID().slice(0, 8), role: 'subscriber', filter, cursor_init: 'oldest' });
    return sub.cursor_id;
  }
  function emitFixture(type = 'wicked.review.fixture.recorded', extra = {}) {
    return emit(db, config, { event_type: type, domain: 'review', payload: { n: 1 }, ...extra });
  }
  const rowExists = (id) => !!db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(id);

  // ---------------------------------------------------------------- BUS-01
  it('BUS-01: a consumer offline for 25 h still receives the event (no sweep before expires_at)', () => {
    const cursor = subscriber();
    const { event_id } = emitFixture();
    // Emitted 25 h ago: past the 24 h dedup window, inside the 72 h lifetime.
    const emitted = Date.now() - 25 * HOUR;
    db.prepare('UPDATE events SET emitted_at = ?, dedup_expires_at = ?, expires_at = ? WHERE event_id = ?')
      .run(emitted, emitted + 24 * HOUR, emitted + 72 * HOUR, event_id);
    const res = runSweep(db, config);
    expect(res.events_deleted).toBe(0);
    expect(rowExists(event_id)).toBe(true);
    expect(poll(db, cursor).map((e) => e.event_id)).toEqual([event_id]);
  });

  it('BUS-01: past expires_at, an unacked event is RETAINED by default, still delivered, and reported', () => {
    const cursor = subscriber();
    const { event_id } = emitFixture();
    const res = runSweep(db, { ...config, now: Date.now() + 80 * HOUR });
    expect(res.unacked_policy).toBe('retain');
    expect(res.events_deleted).toBe(0);
    expect(res.unacked.retained).toBe(1);
    expect(res.unacked.cursors).toEqual([
      expect.objectContaining({ cursor_id: cursor, count: 1, oldest_event_id: event_id, disposition: 'retained' }),
    ]);
    expect(poll(db, cursor).map((e) => e.event_id)).toEqual([event_id]);
  });

  it('BUS-01: once acked, the expired event is swept (retention ends with the obligation)', () => {
    const cursor = subscriber();
    const { event_id } = emitFixture();
    ack(db, cursor, event_id);
    const res = runSweep(db, { ...config, now: Date.now() + 80 * HOUR });
    expect(res.events_deleted).toBe(1);
    expect(res.unacked.retained).toBe(0);
    expect(rowExists(event_id)).toBe(false);
  });

  it('BUS-01: an expired event no active cursor owes (filter mismatch / deregistered) is swept', () => {
    subscriber('wicked.other.thing.*');
    const { event_id } = emitFixture();
    const res = runSweep(db, { ...config, now: Date.now() + 80 * HOUR });
    expect(res.events_deleted).toBe(1);
    expect(rowExists(event_id)).toBe(false);
  });

  it("BUS-01: unacked_policy 'discard' deletes and REPORTS the owed event", () => {
    const cursor = subscriber();
    const { event_id } = emitFixture();
    const res = runSweep(db, { ...config, unacked_policy: 'discard', now: Date.now() + 80 * HOUR });
    expect(res.events_deleted).toBe(1);
    expect(res.unacked.discarded).toBe(1);
    expect(res.unacked.cursors[0]).toMatchObject({ cursor_id: cursor, disposition: 'discarded', oldest_event_id: event_id });
  });

  it("BUS-01: unacked_policy 'archive' copies the owed event to events_archive before deleting", () => {
    subscriber();
    const { event_id } = emitFixture();
    const res = runSweep(db, { ...config, unacked_policy: 'archive', now: Date.now() + 80 * HOUR });
    expect(res.unacked.archived).toBe(1);
    expect(rowExists(event_id)).toBe(false);
    expect(db.prepare('SELECT event_id FROM events_archive WHERE event_id = ?').get(event_id)).toBeTruthy();
  });

  it('BUS-01: an invalid unacked_policy fails loudly', () => {
    expect(() => runSweep(db, { ...config, unacked_policy: 'drop-it' })).toThrow(/unacked_policy/);
  });

  it('BUS-01: the dedup window is separate from retention — a reused key is a duplicate only while its window is open', () => {
    const first = emitFixture('wicked.review.fixture.recorded', { idempotency_key: 'k-1' });
    let dup;
    try { emitFixture('wicked.review.fixture.recorded', { idempotency_key: 'k-1' }); } catch (e) { dup = e; }
    expect(dup).toBeInstanceOf(WBError);
    expect(dup.error).toBe('WB-002');
    // The dedup window closes (24 h) while the row is still alive (72 h).
    db.prepare('UPDATE events SET dedup_expires_at = ? WHERE event_id = ?').run(Date.now() - 1, first.event_id);
    const second = emitFixture('wicked.review.fixture.recorded', { idempotency_key: 'k-1' });
    expect(second.event_id).not.toBe(first.event_id);
    expect(rowExists(first.event_id)).toBe(true); // the old event still lives out its lifetime
  });

  it('BUS-01: CLI cleanup reports the reconciliation and honours --unacked-policy', () => {
    subscriber();
    const { event_id } = emitFixture();
    db.prepare('UPDATE events SET expires_at = ?, dedup_expires_at = ? WHERE event_id = ?')
      .run(Date.now() - HOUR, Date.now() - HOUR, event_id);
    db.close();
    const dry = run(['cleanup', '--dry-run'], { dataDir: tmpDir });
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ events_deleted: 0, unacked_policy: 'retain', unacked: { retained: 1 }, dry_run: true });
    const kept = JSON.parse(run(['cleanup'], { dataDir: tmpDir }).stdout);
    expect(kept).toMatchObject({ events_deleted: 0, unacked: { retained: 1 } });
    const dropped = JSON.parse(run(['cleanup', '--unacked-policy', 'discard'], { dataDir: tmpDir }).stdout);
    expect(dropped).toMatchObject({ events_deleted: 1, unacked: { discarded: 1 } });
    db = openDb(config);
  });

  // ---------------------------------------------------------------- BUS-02
  it('BUS-02: default CLI cleanup stays in-db (no warm buckets); --tiered writes a monthly bucket queries read', () => {
    const { event_id } = emitFixture();
    db.prepare('UPDATE events SET expires_at = ?, dedup_expires_at = ? WHERE event_id = ?')
      .run(Date.now() - HOUR, Date.now() - HOUR, event_id);
    db.close();
    const plain = JSON.parse(run(['cleanup', '--dry-run'], { dataDir: tmpDir }).stdout);
    expect(plain.events_deleted).toBe(1);
    expect(listBuckets(archiveDir(tmpDir))).toEqual([]);
    const tiered = run(['cleanup', '--tiered'], { dataDir: tmpDir });
    expect(tiered.exitCode).toBe(0);
    expect(JSON.parse(tiered.stdout).events_moved).toBe(1);
    const buckets = listBuckets(archiveDir(tmpDir));
    expect(buckets.length).toBe(1);
    db = openDb(config);
    expect(rowExists(event_id)).toBe(false);
    const rows = pollResolve(db, archiveDir(tmpDir), { lastEventId: 0 });
    expect(rows.map((r) => r.event_id)).toContain(event_id);
  });

  // ---------------------------------------------------------------- BUS-03
  it('BUS-03: a disk-full insert throws WB-004 and leaves no row — nothing was accepted', () => {
    const pages = db.pragma('page_count', { simple: true });
    db.pragma(`max_page_count = ${pages}`);
    let err;
    try {
      emit(db, config, {
        event_type: 'wicked.review.fixture.recorded', domain: 'review',
        idempotency_key: 'disk-full-key', payload: { blob: 'x'.repeat(900_000) },
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WBError);
    expect(err.error).toBe('WB-004');
    const check = new Database(join(tmpDir, 'bus.db'), { readonly: true });
    try {
      expect(check.prepare("SELECT COUNT(*) AS n FROM events WHERE idempotency_key = 'disk-full-key'").get().n).toBe(0);
    } finally { check.close(); }
    db = openDb(config);
  });

  // ---------------------------------------------------------------- BUS-04
  it('BUS-04: CAS GC keeps a blob a dead-letter row still references after its event is gone', () => {
    db.prepare(`INSERT INTO schemas (event_type, version, json_schema, retention, payload_max_bytes, archive_to, payload_oversize)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('wicked.review.fixture.recorded', 1, JSON.stringify({ type: 'object' }), 'default', 32, 'warm', 'cas-auto');
    const cursor = subscriber();
    const { event_id } = emit(db, config, { event_type: 'wicked.review.fixture.recorded', domain: 'review', payload: { data: 'y'.repeat(200) } });
    const ev = db.prepare('SELECT * FROM events WHERE event_id = ?').get(event_id);
    const sha = ev.payload_cas_sha;
    expect(JSON.parse(ev.payload)).toEqual({ $cas: sha });
    // The subscriber's retry exhaustion snapshot (same fields as moveToDeadLetter).
    const subId = db.prepare('SELECT subscription_id FROM cursors WHERE cursor_id = ?').get(cursor).subscription_id;
    db.prepare(`INSERT INTO dead_letters (cursor_id, subscription_id, event_id, event_type, domain, subdomain,
      payload, emitted_at, attempts, last_error, dead_lettered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cursor, subId, event_id, ev.event_type, ev.domain, ev.subdomain, ev.payload, ev.emitted_at, 5, 'handler failed', Date.now());
    ack(db, cursor, event_id);
    runSweep(db, { ...config, now: Date.now() + 80 * HOUR }); // original event swept
    expect(rowExists(event_id)).toBe(false);
    const res = casGc({ dataDir: tmpDir, liveDb: db, grace_days: 0, now: Date.now() + 30 * 86400_000 });
    expect(res.deleted).toBe(0);
    expect(casExists(tmpDir, sha)).toBe(true);
    expect(JSON.parse(casGet(tmpDir, sha).toString('utf8'))).toEqual({ data: 'y'.repeat(200) });
    // Once the DLQ row is dropped, the blob is unreferenced and collectable.
    db.prepare('DELETE FROM dead_letters').run();
    expect(casGc({ dataDir: tmpDir, liveDb: db, grace_days: 0, now: Date.now() + 30 * 86400_000 }).deleted).toBe(1);
  });
});
