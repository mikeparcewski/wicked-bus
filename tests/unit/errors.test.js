import { describe, it, expect } from 'vitest';
import { WBError, ERROR_CODES, EXIT_CODES } from '../../lib/errors.js';

describe('WBError', () => {
  it('constructs with error code, name, and context', () => {
    const err = new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: 'Missing field',
      missing_fields: ['event_type'],
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.error).toBe('WB-001');
    expect(err.code).toBe('INVALID_EVENT_SCHEMA');
    expect(err.message).toBe('Missing field');
    expect(err.context.missing_fields).toEqual(['event_type']);
  });

  it('uses code as message when context.message is not provided', () => {
    const err = new WBError('WB-002', 'DUPLICATE_EVENT');
    expect(err.message).toBe('DUPLICATE_EVENT');
  });

  it('toJSON returns structured envelope', () => {
    const err = new WBError('WB-003', 'CURSOR_BEHIND_TTL_WINDOW', {
      message: 'Behind',
      cursor_last_event_id: 5,
    });
    const json = err.toJSON();
    expect(json).toEqual({
      error: 'WB-003',
      code: 'CURSOR_BEHIND_TTL_WINDOW',
      message: 'Behind',
      context: { message: 'Behind', cursor_last_event_id: 5 },
    });
  });

  it('JSON.stringify works on WBError', () => {
    const err = new WBError('WB-004', 'DISK_FULL', { message: 'Full' });
    const str = JSON.stringify(err);
    const parsed = JSON.parse(str);
    expect(parsed.error).toBe('WB-004');
  });
});

describe('ERROR_CODES', () => {
  it('preserves the v1 contract for WB-001 through WB-006', () => {
    expect(ERROR_CODES['WB-001']).toBe('INVALID_EVENT_SCHEMA');
    expect(ERROR_CODES['WB-002']).toBe('DUPLICATE_EVENT');
    expect(ERROR_CODES['WB-003']).toBe('CURSOR_BEHIND_TTL_WINDOW');
    expect(ERROR_CODES['WB-004']).toBe('DISK_FULL');
    expect(ERROR_CODES['WB-005']).toBe('SCHEMA_VERSION_UNSUPPORTED');
    expect(ERROR_CODES['WB-006']).toBe('CURSOR_NOT_FOUND');
  });

  it('adds v2 codes WB-007 through WB-013 (DESIGN-v2.md §10.2)', () => {
    expect(ERROR_CODES['WB-007']).toBe('LARGE_SCAN_REJECTED');
    expect(ERROR_CODES['WB-008']).toBe('PAYLOAD_TOO_LARGE');
    expect(ERROR_CODES['WB-009']).toBe('SCHEMA_MISMATCH');
    expect(ERROR_CODES['WB-010']).toBe('CAS_GC_INCOMPLETE_BUCKET_SET');
    expect(ERROR_CODES['WB-011']).toBe('UI_TOKEN_PERMISSION_MISMATCH');
    expect(ERROR_CODES['WB-012']).toBe('LIVE_TIER_BLOAT_WARNING');
    expect(ERROR_CODES['WB-013']).toBe('SPILL_BUCKET_UNAVAILABLE');
  });
});

describe('EXIT_CODES', () => {
  it('maps error codes to exit codes', () => {
    expect(EXIT_CODES['WB-001']).toBe(1);
    expect(EXIT_CODES['WB-002']).toBe(2);
    expect(EXIT_CODES['WB-003']).toBe(3);
    expect(EXIT_CODES['WB-004']).toBe(4);
    expect(EXIT_CODES['WB-005']).toBe(5);
    expect(EXIT_CODES['WB-006']).toBe(6);
  });
});
