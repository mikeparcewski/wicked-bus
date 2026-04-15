import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { register } from '../../lib/register.js';
import { subscribe, registerOrResume } from '../../lib/subscribe.js';
import { listDeadLetters, replayDeadLetter, dropDeadLetter } from '../../lib/dlq.js';
import { WBError } from '../../lib/errors.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Wait until predicate() returns truthy, polling every 5ms up to timeoutMs.
 * Use this instead of fixed sleeps so tests aren't time-fragile.
 */
async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await wait(5);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('subscribe', () => {
  let db, config, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-subscribe-test-' + randomUUID());
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

  function emitEvent(type = 'wicked.fact.extracted.user', payload = { fact: 'sky is blue' }) {
    return emit(db, config, {
      event_type: type,
      domain: 'wicked-brain',
      payload,
    });
  }

  describe('registerOrResume', () => {
    it('creates a new subscription when none exists', () => {
      const result = registerOrResume(db, {
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
      });
      expect(result.created).toBe(true);
      expect(result.subscription_id).toBeTruthy();
      expect(result.cursor_id).toBeTruthy();
    });

    it('reuses existing subscription on second call', () => {
      const first = registerOrResume(db, {
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
      });
      const second = registerOrResume(db, {
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'latest',
      });
      expect(second.created).toBe(false);
      expect(second.subscription_id).toBe(first.subscription_id);
      expect(second.cursor_id).toBe(first.cursor_id);
    });

    it('does not reuse a subscription with a different filter', () => {
      const first = registerOrResume(db, {
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
      });
      const second = registerOrResume(db, {
        plugin: 'wicked-brain',
        filter: 'wicked.crew.phase.*',
        cursor_init: 'oldest',
      });
      expect(second.subscription_id).not.toBe(first.subscription_id);
    });
  });

  describe('basic delivery', () => {
    it('invokes handler with parsed payload, advances cursor, then idle', async () => {
      emitEvent();
      const seen = [];
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        handler: async (event) => { seen.push(event); },
      });

      await waitFor(() => seen.length === 1);
      await sub.stop();

      expect(seen[0].event_type).toBe('wicked.fact.extracted.user');
      expect(seen[0].payload).toEqual({ fact: 'sky is blue' });

      // No DLQ entries on success
      expect(listDeadLetters(db)).toHaveLength(0);
      // No retry state lingering
      const attempts = db.prepare('SELECT * FROM delivery_attempts').all();
      expect(attempts).toHaveLength(0);
    });

    it('processes events in cursor order', async () => {
      for (let i = 0; i < 5; i++) {
        emitEvent('wicked.fact.extracted.batch', { i });
      }
      const seen = [];
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        handler: async (event) => { seen.push(event.payload.i); },
      });

      await waitFor(() => seen.length === 5);
      await sub.stop();

      expect(seen).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe('retry and DLQ', () => {
    it('fails fast and DLQs on first failure when maxRetries=0', async () => {
      emitEvent();
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 0,
        handler: async () => { throw new Error('always fails'); },
      });

      await waitFor(() => listDeadLetters(db).length === 1);
      await sub.stop();

      const dlq = listDeadLetters(db);
      expect(dlq).toHaveLength(1);
      expect(dlq[0].attempts).toBe(1);
      expect(dlq[0].last_error).toBe('always fails');
      expect(dlq[0].plugin).toBe('wicked-brain');
    });

    it('retries up to maxRetries then DLQs', async () => {
      emitEvent();
      let calls = 0;
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 3,
        backoffMs: 1,
        handler: async () => { calls++; throw new Error('flaky'); },
      });

      await waitFor(() => listDeadLetters(db).length === 1);
      await sub.stop();

      // maxRetries=3 means: initial attempt + 3 retries on failure = 4 total
      // before DLQ (the loop DLQs when attempts > maxRetries, so attempt #4
      // (which sets attempts=4) triggers the DLQ).
      expect(calls).toBe(4);
      const dlq = listDeadLetters(db);
      expect(dlq[0].attempts).toBe(4);
    });

    it('succeeds on retry without DLQing', async () => {
      emitEvent();
      let calls = 0;
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 3,
        backoffMs: 1,
        handler: async () => {
          calls++;
          if (calls < 3) throw new Error('try again');
        },
      });

      await waitFor(() => calls === 3);
      // Give the loop a tick to clean up
      await wait(20);
      await sub.stop();

      expect(listDeadLetters(db)).toHaveLength(0);
      // delivery_attempts cleaned up on success
      expect(db.prepare('SELECT * FROM delivery_attempts').all()).toHaveLength(0);
    });

    it('invokes onError before retry/DLQ', async () => {
      emitEvent();
      const errors = [];
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 1,
        backoffMs: 1,
        handler: async () => { throw new Error('oops'); },
        onError: (err, event) => { errors.push({ msg: err.message, event_id: event.event_id }); },
      });

      await waitFor(() => listDeadLetters(db).length === 1);
      await sub.stop();

      expect(errors.length).toBe(2);
      expect(errors[0].msg).toBe('oops');
    });

    it('invokes onDeadLetter when an event is moved to DLQ', async () => {
      emitEvent();
      const dlqEvents = [];
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 0,
        handler: async () => { throw new Error('nope'); },
        onDeadLetter: (event, reason) => { dlqEvents.push({ event_id: event.event_id, reason }); },
      });

      await waitFor(() => dlqEvents.length === 1);
      await sub.stop();

      expect(dlqEvents[0].reason).toBe('nope');
    });
  });

  describe('restart resume from delivery_attempts', () => {
    it('restores attempt counter from delivery_attempts on a fresh subscribe', async () => {
      // Set up: register subscription, emit event, manually pre-populate
      // delivery_attempts as if a previous process died after 3 retries.
      const reg = register(db, {
        plugin: 'wicked-brain',
        role: 'subscriber',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
      });
      const e = emit(db, config, {
        event_type: 'wicked.fact.extracted.poison',
        domain: 'wicked-brain',
        payload: { kind: 'poison' },
      });
      db.prepare(`
        INSERT INTO delivery_attempts (cursor_id, event_id, attempts, last_attempt_at, last_error)
        VALUES (?, ?, ?, ?, ?)
      `).run(reg.cursor_id, e.event_id, 3, Date.now(), 'previous run failure');

      // Now subscribe with maxRetries=3. Because attempts is already 3,
      // the very next failure (attempts=4) should DLQ immediately.
      let calls = 0;
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        pollIntervalMs: 10,
        maxRetries: 3,
        backoffMs: 1,
        handler: async () => { calls++; throw new Error('still broken'); },
      });

      await waitFor(() => listDeadLetters(db).length === 1);
      await sub.stop();

      // Only one new call — the restored counter took it straight to DLQ
      expect(calls).toBe(1);
      const dlq = listDeadLetters(db);
      expect(dlq[0].attempts).toBe(4);
      expect(dlq[0].last_error).toBe('still broken');
    });
  });

  describe('stop() during backoff', () => {
    it('cancels the backoff timer and DLQs the in-flight event', async () => {
      emitEvent();
      let firstFail = false;
      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 5,
        backoffMs: 60_000, // long enough that stop() is the only way out
        handler: async () => {
          firstFail = true;
          throw new Error('still bad');
        },
      });

      await waitFor(() => firstFail);
      // Now the loop is sleeping in backoff; calling stop() should DLQ
      const stopStart = Date.now();
      await sub.stop();
      const stopMs = Date.now() - stopStart;
      // Should not wait the full 60s
      expect(stopMs).toBeLessThan(2000);

      const dlq = listDeadLetters(db);
      expect(dlq).toHaveLength(1);
      expect(dlq[0].last_error).toBe('shutdown during backoff');
    });
  });

  describe('replay drain', () => {
    it('drains replay-marked DLQ rows and deletes on success', async () => {
      // First: produce a DLQ entry by failing
      emitEvent();
      let phase = 'fail';
      const sub1 = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 0,
        handler: async () => {
          if (phase === 'fail') throw new Error('boom');
        },
      });

      await waitFor(() => listDeadLetters(db).length === 1);
      await sub1.stop();

      const [dlqRow] = listDeadLetters(db);
      replayDeadLetter(db, dlqRow.dl_id);

      // Now bring up a new subscriber with a healed handler
      phase = 'ok';
      let drained = 0;
      const sub2 = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        pollIntervalMs: 10,
        handler: async () => { drained++; },
      });

      await waitFor(() => drained === 1 && listDeadLetters(db).length === 0);
      await sub2.stop();
    });

    it('clears replay_requested_at and increments attempts when replay handler still fails', async () => {
      emitEvent();
      const sub1 = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10,
        maxRetries: 0,
        handler: async () => { throw new Error('original failure'); },
      });
      await waitFor(() => listDeadLetters(db).length === 1);
      await sub1.stop();

      const [dlqRow] = listDeadLetters(db);
      const originalAttempts = dlqRow.attempts;
      replayDeadLetter(db, dlqRow.dl_id);

      const sub2 = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        pollIntervalMs: 10,
        handler: async () => { throw new Error('still broken on replay'); },
      });

      // Wait until the replay attempt completes (replay_requested_at cleared)
      await waitFor(() => {
        const row = db.prepare('SELECT * FROM dead_letters WHERE dl_id = ?').get(dlqRow.dl_id);
        return row && row.replay_requested_at == null && row.attempts > originalAttempts;
      });
      await sub2.stop();

      const updated = db.prepare('SELECT * FROM dead_letters WHERE dl_id = ?').get(dlqRow.dl_id);
      expect(updated.attempts).toBe(originalAttempts + 1);
      expect(updated.last_error).toBe('still broken on replay');
      expect(updated.replay_requested_at).toBeNull();
    });
  });

  describe('getLag', () => {
    it('returns cursor_lag, oldest_unacked_age_ms, and dlq_count', async () => {
      emitEvent();
      emitEvent();
      emitEvent();

      const sub = subscribe({
        db,
        plugin: 'wicked-brain',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
        pollIntervalMs: 10_000, // slow so we measure lag before processing
        handler: async () => {},
      });

      // Loop hasn't ticked yet (next tick at +0ms but we measure synchronously)
      // — call getLag immediately to capture the pre-processing state
      const lag = sub.getLag();
      expect(lag).toHaveProperty('cursor_lag');
      expect(lag).toHaveProperty('oldest_unacked_age_ms');
      expect(lag).toHaveProperty('dlq_count');
      expect(lag.dlq_count).toBe(0);

      await sub.stop();
    });
  });

  describe('input validation', () => {
    it('throws if db is missing', () => {
      expect(() => subscribe({ plugin: 'p', filter: 'f', handler: () => {} }))
        .toThrow(/db is required/);
    });

    it('throws if handler is not a function', () => {
      expect(() => subscribe({ db, plugin: 'p', filter: 'f' }))
        .toThrow(/handler/);
    });
  });
});

describe('replayDeadLetter / dropDeadLetter', () => {
  let db, tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-dlq-ops-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    db = openDb(loadConfig());
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
    if (originalEnv) process.env.WICKED_BUS_DATA_DIR = originalEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  function seedDlqRow() {
    const reg = register(db, {
      plugin: 'wicked-brain',
      role: 'subscriber',
      filter: 'wicked.fact.extracted.*',
      cursor_init: 'oldest',
    });
    const result = db.prepare(`
      INSERT INTO dead_letters (
        cursor_id, subscription_id, event_id, event_type, domain, subdomain,
        payload, emitted_at, attempts, last_error, dead_lettered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reg.cursor_id, reg.subscription_id, 1,
      'wicked.fact.extracted.test', 'wicked-brain', '',
      JSON.stringify({ foo: 'bar' }), Date.now(), 1, 'orig', Date.now()
    );
    return Number(result.lastInsertRowid);
  }

  it('replayDeadLetter sets replay_requested_at', () => {
    const dlId = seedDlqRow();
    const result = replayDeadLetter(db, dlId);
    expect(result.replayed).toBe(true);
    const row = db.prepare('SELECT * FROM dead_letters WHERE dl_id = ?').get(dlId);
    expect(row.replay_requested_at).not.toBeNull();
  });

  it('replayDeadLetter throws WB-006 for missing dl_id', () => {
    expect(() => replayDeadLetter(db, 9999)).toThrow(WBError);
  });

  it('dropDeadLetter removes the row', () => {
    const dlId = seedDlqRow();
    const result = dropDeadLetter(db, dlId);
    expect(result.dropped).toBe(true);
    const row = db.prepare('SELECT * FROM dead_letters WHERE dl_id = ?').get(dlId);
    expect(row).toBeUndefined();
  });

  it('dropDeadLetter throws WB-006 for missing dl_id', () => {
    expect(() => dropDeadLetter(db, 9999)).toThrow(WBError);
  });
});
