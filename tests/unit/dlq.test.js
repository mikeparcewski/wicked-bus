import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { poll } from '../../lib/poll.js';
import { register } from '../../lib/register.js';
import { listDeadLetters } from '../../lib/dlq.js';
import { WBError } from '../../lib/errors.js';

describe('dlq', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-dlq-test-' + randomUUID());
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

  function emitEvent(type = 'wicked.fact.extracted.user') {
    return emit(db, config, {
      event_type: type,
      domain: 'wicked-brain',
      payload: { fact: 'sky is blue' },
    });
  }

  function registerSubscriber(plugin, filter = 'wicked.fact.extracted.*') {
    return register(db, {
      plugin,
      role: 'subscriber',
      filter,
      cursor_init: 'oldest',
    });
  }

  function deadLetter(reg, eventRow, attempts = 3, lastError = 'handler timeout') {
    db.prepare(`
      INSERT INTO dead_letters (
        cursor_id, subscription_id, event_id, event_type, domain, subdomain,
        payload, emitted_at, attempts, last_error, dead_lettered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reg.cursor_id,
      reg.subscription_id,
      eventRow.event_id,
      eventRow.event_type,
      eventRow.domain,
      eventRow.subdomain ?? '',
      typeof eventRow.payload === 'string' ? eventRow.payload : JSON.stringify(eventRow.payload),
      eventRow.emitted_at,
      attempts,
      lastError,
      Date.now()
    );
  }

  describe('listDeadLetters', () => {
    it('returns empty array when DLQ is empty', () => {
      const rows = listDeadLetters(db);
      expect(rows).toEqual([]);
    });

    it('returns all DLQ rows ordered by dead_lettered_at desc', () => {
      const reg = registerSubscriber('wicked-brain');
      emitEvent();
      emitEvent('wicked.fact.extracted.note');
      const polled = poll(db, reg.cursor_id);

      deadLetter(reg, polled[0]);
      // Force a later dead_lettered_at by sleeping via direct timestamp control
      const later = Date.now() + 1000;
      db.prepare(`
        INSERT INTO dead_letters (
          cursor_id, subscription_id, event_id, event_type, domain, subdomain,
          payload, emitted_at, attempts, last_error, dead_lettered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reg.cursor_id, reg.subscription_id, polled[1].event_id,
        polled[1].event_type, polled[1].domain, polled[1].subdomain ?? '',
        polled[1].payload, polled[1].emitted_at,
        3, 'second failure', later
      );

      const rows = listDeadLetters(db);
      expect(rows).toHaveLength(2);
      expect(rows[0].event_id).toBe(polled[1].event_id);
      expect(rows[1].event_id).toBe(polled[0].event_id);
    });

    it('parses payload from JSON string into object', () => {
      const reg = registerSubscriber('wicked-brain');
      emitEvent();
      const polled = poll(db, reg.cursor_id);
      deadLetter(reg, polled[0]);

      const rows = listDeadLetters(db);
      expect(rows[0].payload).toEqual({ fact: 'sky is blue' });
    });

    it('joins plugin name from subscriptions', () => {
      const reg = registerSubscriber('wicked-brain');
      emitEvent();
      const polled = poll(db, reg.cursor_id);
      deadLetter(reg, polled[0]);

      const rows = listDeadLetters(db);
      expect(rows[0].plugin).toBe('wicked-brain');
    });

    it('filters by plugin', () => {
      const brain = registerSubscriber('wicked-brain');
      const crew = registerSubscriber('wicked-crew');
      emitEvent();
      const brainPolled = poll(db, brain.cursor_id);
      const crewPolled = poll(db, crew.cursor_id);

      deadLetter(brain, brainPolled[0]);
      deadLetter(crew, crewPolled[0]);

      const brainRows = listDeadLetters(db, { plugin: 'wicked-brain' });
      expect(brainRows).toHaveLength(1);
      expect(brainRows[0].plugin).toBe('wicked-brain');

      const crewRows = listDeadLetters(db, { plugin: 'wicked-crew' });
      expect(crewRows).toHaveLength(1);
      expect(crewRows[0].plugin).toBe('wicked-crew');
    });

    it('filters by cursorId', () => {
      const brain = registerSubscriber('wicked-brain');
      const crew = registerSubscriber('wicked-crew');
      emitEvent();
      deadLetter(brain, poll(db, brain.cursor_id)[0]);
      deadLetter(crew, poll(db, crew.cursor_id)[0]);

      const rows = listDeadLetters(db, { cursorId: brain.cursor_id });
      expect(rows).toHaveLength(1);
      expect(rows[0].cursor_id).toBe(brain.cursor_id);
    });

    it('respects limit option', () => {
      const reg = registerSubscriber('wicked-brain');
      for (let i = 0; i < 5; i++) emitEvent('wicked.fact.extracted.batch');
      const polled = poll(db, reg.cursor_id);
      polled.forEach(p => deadLetter(reg, p));

      const rows = listDeadLetters(db, { limit: 3 });
      expect(rows).toHaveLength(3);
    });

    it('throws WB-001 if a payload is malformed JSON', () => {
      const reg = registerSubscriber('wicked-brain');
      db.prepare(`
        INSERT INTO dead_letters (
          cursor_id, subscription_id, event_id, event_type, domain, subdomain,
          payload, emitted_at, attempts, last_error, dead_lettered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reg.cursor_id, reg.subscription_id, 1,
        'wicked.fact.extracted.broken', 'wicked-brain', '',
        '{not json', Date.now(), 1, 'parse error', Date.now()
      );

      expect(() => listDeadLetters(db)).toThrow(WBError);
    });
  });

  describe('WB-003 regression — DLQ rows must not corrupt cursor-behind detection', () => {
    it('poll() does not throw WB-003 when DLQ rows exist with low event_ids', () => {
      // This is the load-bearing regression test for the design decision to
      // keep dead_letters physically separate from events. If dead_letters were
      // part of the events table (or if poll() included them in MIN(event_id)),
      // an old DLQ entry could trigger a false WB-003 cursor-behind error.
      const reg = registerSubscriber('wicked-brain', 'wicked.fact.extracted.*');
      emitEvent();
      const polled = poll(db, reg.cursor_id);
      expect(polled).toHaveLength(1);
      const firstEventId = polled[0].event_id;

      // Simulate DLQing this event with a low (potentially stale) event_id
      deadLetter(reg, polled[0]);

      // Emit a new event so the events table has fresh content
      emitEvent('wicked.fact.extracted.fresh');

      // poll() should NOT throw WB-003 just because a DLQ row references a
      // low event_id. The MIN(event_id) check must look only at the events
      // table, not at dead_letters.
      expect(() => poll(db, reg.cursor_id)).not.toThrow();

      // Sanity: the second event is still pollable
      const next = poll(db, reg.cursor_id);
      expect(next.length).toBeGreaterThanOrEqual(1);
      expect(next.find(e => e.event_id > firstEventId)).toBeDefined();
    });
  });
});
