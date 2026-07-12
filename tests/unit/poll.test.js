import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { poll, ack, matchesFilter, reanchorCursor } from '../../lib/poll.js';
import { register } from '../../lib/register.js';
import { WBError } from '../../lib/errors.js';

describe('poll', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-poll-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = loadConfig();
    db = openDb(config);
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
    if (originalEnv) {
      process.env.WICKED_BUS_DATA_DIR = originalEnv;
    } else {
      delete process.env.WICKED_BUS_DATA_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  function emitEvent(type = 'wicked.test.run.completed', source = 'wicked-testing') {
    return emit(db, config, {
      event_type: type,
      domain: source,
      payload: { test: true },
    });
  }

  function registerSub(filter = 'wicked.test.run.*', cursorInit = 'oldest') {
    return register(db, {
      plugin: 'test-consumer',
      role: 'subscriber',
      filter,
      cursor_init: cursorInit,
    });
  }

  it('returns events matching filter', () => {
    emitEvent();
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('wicked.test.run.completed');
  });

  it('returns events in event_id ASC order', () => {
    emitEvent('wicked.test.run.started');
    emitEvent('wicked.test.run.completed');
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events[0].event_id).toBeLessThan(events[1].event_id);
  });

  it('limits results by batchSize', () => {
    for (let i = 0; i < 5; i++) emitEvent();
    const reg = registerSub();
    const events = poll(db, reg.cursor_id, { batchSize: 2 });
    expect(events).toHaveLength(2);
  });

  it('excludes events before cursor position', () => {
    emitEvent();
    emitEvent();
    const reg = registerSub('wicked.test.run.*', 'latest');
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(0);
  });

  it('excludes expired events (expires_at < now)', () => {
    // Emit with very short TTL
    emit(db, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
      ttl_hours: 0, // expires immediately
    });
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(0);
  });

  it('throws WB-006 for non-existent cursor', () => {
    expect(() => poll(db, 'nonexistent')).toThrow(WBError);
    try {
      poll(db, 'nonexistent');
    } catch (err) {
      expect(err.error).toBe('WB-006');
    }
  });

  it('throws WB-006 for deregistered cursor', () => {
    emitEvent();
    const reg = registerSub();
    // Deregister cursor
    db.prepare('UPDATE cursors SET deregistered_at = ? WHERE cursor_id = ?')
      .run(Date.now(), reg.cursor_id);
    expect(() => poll(db, reg.cursor_id)).toThrow(WBError);
  });

  it('throws WB-003 when cursor is behind oldest row', () => {
    // Emit 5 events
    for (let i = 0; i < 5; i++) emitEvent();
    // Register subscriber starting from oldest
    const reg = registerSub('wicked.test.run.*', 'oldest');
    // Delete events 1-3 to simulate sweep
    db.prepare('DELETE FROM events WHERE event_id <= 3').run();

    try {
      poll(db, reg.cursor_id);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-003');
      expect(err.context.cursor_last_event_id).toBe(0);
      expect(err.context.oldest_available_event_id).toBe(4);
    }
  });

  it('does not throw WB-003 when cursor is at MIN(event_id) - 1', () => {
    for (let i = 0; i < 3; i++) emitEvent();
    // Delete event 1, so MIN = 2
    db.prepare('DELETE FROM events WHERE event_id = 1').run();
    // Set cursor to 1 (which is MIN(2) - 1)
    const reg = registerSub();
    db.prepare('UPDATE cursors SET last_event_id = 1 WHERE cursor_id = ?')
      .run(reg.cursor_id);
    // Should NOT throw
    const events = poll(db, reg.cursor_id);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('does not throw WB-003 when events table is empty', () => {
    const reg = registerSub();
    const events = poll(db, reg.cursor_id);
    expect(events).toHaveLength(0);
  });

  // ── WB-003 self-recovery via reanchorCursor ───────────────────────────────
  describe('reanchorCursor (WB-003 recovery)', () => {
    it('re-anchors a behind-TTL cursor so poll resumes from the oldest survivor', () => {
      for (let i = 0; i < 5; i++) emitEvent();          // event_ids 1..5
      const reg = registerSub('wicked.test.run.*', 'oldest'); // cursor at 0
      db.prepare('DELETE FROM events WHERE event_id <= 2').run(); // MIN = 3

      // Sanity: the cursor is behind the sweep window and poll throws WB-003.
      let ctx;
      try {
        poll(db, reg.cursor_id);
        expect.fail('should throw WB-003');
      } catch (err) {
        expect(err.error).toBe('WB-003');
        ctx = err.context;
      }
      expect(ctx.oldest_available_event_id).toBe(3);

      // Recover exactly as the CLI does: re-anchor to oldest_available - 1.
      const res = reanchorCursor(db, reg.cursor_id, ctx.oldest_available_event_id - 1);
      expect(res.reanchored).toBe(true);
      expect(res.last_event_id).toBe(2);

      // Poll now succeeds and delivers EVERY surviving event — none skipped.
      const events = poll(db, reg.cursor_id);
      expect(events.map(e => e.event_id)).toEqual([3, 4, 5]);
    });

    it('does not skip still-deliverable events (no fast-forward to head)', () => {
      for (let i = 0; i < 6; i++) emitEvent();          // 1..6
      const reg = registerSub('wicked.test.run.*', 'oldest');
      db.prepare('DELETE FROM events WHERE event_id <= 3').run(); // sweep 1..3, MIN = 4

      let oldest;
      try {
        poll(db, reg.cursor_id);
      } catch (err) {
        oldest = err.context.oldest_available_event_id; // 4
      }
      reanchorCursor(db, reg.cursor_id, oldest - 1); // anchor to 3

      // Drains 4,5,6 — the survivors — rather than jumping to MAX(6) and
      // silently discarding 4 and 5.
      const events = poll(db, reg.cursor_id);
      expect(events.map(e => e.event_id)).toEqual([4, 5, 6]);
    });

    it('persists the new floor durably on the cursor row', () => {
      for (let i = 0; i < 3; i++) emitEvent();
      const reg = registerSub('wicked.test.run.*', 'oldest');
      reanchorCursor(db, reg.cursor_id, 1);
      const cursor = db.prepare('SELECT last_event_id, acked_at FROM cursors WHERE cursor_id = ?')
        .get(reg.cursor_id);
      expect(cursor.last_event_id).toBe(1);
      expect(cursor.acked_at).toBeTruthy();
    });

    it('throws WB-006 for a deregistered cursor', () => {
      const reg = registerSub();
      db.prepare('UPDATE cursors SET deregistered_at = ? WHERE cursor_id = ?')
        .run(Date.now(), reg.cursor_id);
      try {
        reanchorCursor(db, reg.cursor_id, 1);
        expect.fail('should throw');
      } catch (err) {
        expect(err.error).toBe('WB-006');
      }
    });
  });

  it('afterEventId overrides the cursor floor without mutating it', () => {
    for (let i = 0; i < 4; i++) emitEvent();
    const reg = registerSub('wicked.test.run.*', 'oldest'); // cursor at 0

    // With afterEventId=2, only events 3 and 4 come back...
    const page = poll(db, reg.cursor_id, { afterEventId: 2 });
    expect(page.map(e => e.event_id)).toEqual([3, 4]);

    // ...and the persisted cursor is untouched (still 0), so a plain poll
    // still returns the full backlog.
    const cursor = db.prepare('SELECT last_event_id FROM cursors WHERE cursor_id = ?')
      .get(reg.cursor_id);
    expect(cursor.last_event_id).toBe(0);
    expect(poll(db, reg.cursor_id)).toHaveLength(4);
  });

  it('afterEventId pages a backlog larger than one batch (drain --no-ack model)', () => {
    for (let i = 0; i < 5; i++) emitEvent();
    const reg = registerSub('wicked.test.run.*', 'oldest');

    // Page through with batchSize 2, advancing an in-memory floor, never acking.
    let floor = 0;
    const seen = [];
    for (;;) {
      const batch = poll(db, reg.cursor_id, { batchSize: 2, afterEventId: floor });
      if (batch.length === 0) break;
      for (const e of batch) { seen.push(e.event_id); floor = e.event_id; }
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    // Cursor never moved.
    const cursor = db.prepare('SELECT last_event_id FROM cursors WHERE cursor_id = ?')
      .get(reg.cursor_id);
    expect(cursor.last_event_id).toBe(0);
  });

  // ── Wildcard filtering at the SQL layer (buildFilterSql parity) ───────────
  // These exercise the real poll() query path, not just matchesFilter(), to
  // ensure the SQL WHERE clause mirrors the in-memory matcher.
  describe('wildcard filtering (SQL path)', () => {
    function typesFrom(events) {
      return events.map(e => e.event_type).sort();
    }

    it('single-level wicked.X.* returns only one-segment-deep types', () => {
      emitEvent('wicked.test.run');           // matches
      emitEvent('wicked.test.verdict');        // matches
      emitEvent('wicked.test.run.completed');  // too deep — excluded
      const reg = registerSub('wicked.test.*', 'oldest');
      const events = poll(db, reg.cursor_id);
      expect(typesFrom(events)).toEqual(['wicked.test.run', 'wicked.test.verdict']);
    });

    it('multi-level wicked.X.** returns one-or-more-segments-deep types', () => {
      emitEvent('wicked.test.run');            // matches (one deep)
      emitEvent('wicked.test.run.completed');  // matches (two deep)
      emitEvent('wicked.other.thing');         // different prefix — excluded
      const reg = registerSub('wicked.test.**', 'oldest');
      const events = poll(db, reg.cursor_id);
      expect(typesFrom(events)).toEqual(['wicked.test.run', 'wicked.test.run.completed']);
    });

    it('wicked.** returns every event under the wicked prefix (the intuitive filter)', () => {
      emitEvent('wicked.fact.extracted');
      emitEvent('wicked.test.run.completed');
      emitEvent('wicked.a.b.c.d');
      const reg = registerSub('wicked.**', 'oldest');
      const events = poll(db, reg.cursor_id);
      expect(events).toHaveLength(3);
    });

    it('SQL path matches the in-memory matcher for the same inputs', () => {
      const types = [
        'wicked.test.run',
        'wicked.test.run.completed',
        'wicked.test.verdict.created',
        'wicked.other.thing',
      ];
      types.forEach(t => emitEvent(t));

      for (const filter of ['wicked.test.*', 'wicked.test.**', 'wicked.**']) {
        const reg = registerSub(filter, 'oldest');
        const sqlMatched = typesFrom(poll(db, reg.cursor_id));
        const memMatched = types.filter(t => matchesFilter(t, 'wicked-testing', filter)).sort();
        expect(sqlMatched).toEqual(memMatched);
      }
    });
  });
});

describe('ack', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-ack-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    config = loadConfig();
    db = openDb(config);
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
    if (originalEnv) {
      process.env.WICKED_BUS_DATA_DIR = originalEnv;
    } else {
      delete process.env.WICKED_BUS_DATA_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('atomically advances cursor', () => {
    const reg = register(db, {
      plugin: 'test-sub',
      role: 'subscriber',
      filter: 'wicked.test.*',
      cursor_init: 'oldest',
    });
    const result = ack(db, reg.cursor_id, 5);
    expect(result.acked).toBe(true);
    expect(result.cursor_id).toBe(reg.cursor_id);
    expect(result.last_event_id).toBe(5);

    const cursor = db.prepare('SELECT * FROM cursors WHERE cursor_id = ?').get(reg.cursor_id);
    expect(cursor.last_event_id).toBe(5);
    expect(cursor.acked_at).toBeTruthy();
  });

  it('throws WB-006 for non-existent cursor', () => {
    try {
      ack(db, 'nonexistent', 5);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-006');
    }
  });

  it('throws WB-006 for deregistered cursor', () => {
    const reg = register(db, {
      plugin: 'test-sub',
      role: 'subscriber',
      filter: 'wicked.test.*',
      cursor_init: 'oldest',
    });
    db.prepare('UPDATE cursors SET deregistered_at = ? WHERE cursor_id = ?')
      .run(Date.now(), reg.cursor_id);
    expect(() => ack(db, reg.cursor_id, 5)).toThrow(WBError);
  });
});
