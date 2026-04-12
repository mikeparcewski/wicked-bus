import { describe, it, expect } from 'vitest';
import { validateEvent } from '../../lib/validate.js';
import { WBError } from '../../lib/errors.js';

const config = { max_payload_bytes: 1048576 };

const validEvent = {
  event_type: 'wicked.test.run.completed',
  domain: 'wicked-testing',
  payload: { runId: 'abc', status: 'passed' },
};

describe('validateEvent', () => {
  it('accepts a valid event', () => {
    expect(() => validateEvent(validEvent, config)).not.toThrow();
  });

  it('rejects null/undefined event', () => {
    expect(() => validateEvent(null, config)).toThrow(WBError);
  });

  it('rejects missing event_type with WB-001', () => {
    try {
      validateEvent({ domain: 'x', payload: {} }, config);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-001');
      expect(err.context.missing_fields).toContain('event_type');
    }
  });

  it('rejects missing domain', () => {
    try {
      validateEvent({ event_type: 'wicked.a.b', payload: {} }, config);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-001');
      expect(err.context.missing_fields).toContain('domain');
    }
  });

  it('rejects missing payload', () => {
    try {
      validateEvent({ event_type: 'wicked.a.b', domain: 'x' }, config);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-001');
      expect(err.context.missing_fields).toContain('payload');
    }
  });

  it('rejects event_type exceeding 128 chars', () => {
    try {
      validateEvent({
        event_type: 'wicked.' + 'a'.repeat(128),
        domain: 'x',
        payload: {},
      }, config);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-001');
    }
  });

  it('rejects event_type not matching pattern', () => {
    const badTypes = ['test.run.completed', 'WICKED.test.run', 'wicked'];
    for (const t of badTypes) {
      expect(() => validateEvent({
        event_type: t,
        domain: 'x',
        payload: {},
      }, config)).toThrow(WBError);
    }
  });

  it('accepts valid event_type patterns', () => {
    const goodTypes = [
      'wicked.test.run.completed',
      'wicked.a.b',
      'wicked.brain.memory.stored',
    ];
    for (const t of goodTypes) {
      expect(() => validateEvent({
        event_type: t,
        domain: 'x',
        payload: {},
      }, config)).not.toThrow();
    }
  });

  it('rejects domain exceeding 64 chars', () => {
    expect(() => validateEvent({
      event_type: 'wicked.a.b',
      domain: 'x'.repeat(65),
      payload: {},
    }, config)).toThrow(WBError);
  });

  it('rejects non-object payload', () => {
    expect(() => validateEvent({
      event_type: 'wicked.a.b',
      domain: 'x',
      payload: 'not an object',
    }, config)).toThrow(WBError);
  });

  it('rejects array payload', () => {
    expect(() => validateEvent({
      event_type: 'wicked.a.b',
      domain: 'x',
      payload: [1, 2, 3],
    }, config)).toThrow(WBError);
  });

  it('rejects payload exceeding max_payload_bytes', () => {
    const bigPayload = { data: 'x'.repeat(1048577) };
    expect(() => validateEvent({
      event_type: 'wicked.a.b',
      domain: 'x',
      payload: bigPayload,
    }, config)).toThrow(WBError);
  });

  it('rejects invalid semver schema_version', () => {
    expect(() => validateEvent({
      ...validEvent,
      schema_version: 'bad',
    }, config)).toThrow(WBError);
  });

  it('rejects schema_version with major > 1 (WB-005)', () => {
    try {
      validateEvent({
        ...validEvent,
        schema_version: '2.0.0',
      }, config);
      expect.fail('should throw');
    } catch (err) {
      expect(err.error).toBe('WB-005');
      expect(err.context.declared).toBe('2.0.0');
      expect(err.context.max_supported).toBe('1.x');
    }
  });

  it('accepts schema_version 1.x', () => {
    expect(() => validateEvent({
      ...validEvent,
      schema_version: '1.0.0',
    }, config)).not.toThrow();

    expect(() => validateEvent({
      ...validEvent,
      schema_version: '1.5.0',
    }, config)).not.toThrow();
  });

  it('accepts wicked-brain event types and camelCase payload', () => {
    expect(() => validateEvent({
      event_type: 'wicked.brain.memory.stored',
      domain: 'wicked-brain',
      payload: { chunkId: 'mem-abc', tier: 'semantic', tags: ['crew'] },
    }, config)).not.toThrow();
  });
});
