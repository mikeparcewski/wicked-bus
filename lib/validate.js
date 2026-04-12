/**
 * Event validation.
 * @module lib/validate
 */

import { WBError } from './errors.js';

// Event type: wicked.<segments> where segments are lowercase alphanum/underscore separated by dots
const EVENT_TYPE_REGEX = /^wicked\.[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

/**
 * Validate an event object before writing.
 * @param {object} event - { event_type, domain, payload, schema_version?, subdomain?, metadata? }
 * @param {object} config - Merged config with max_payload_bytes
 * @throws {WBError} WB-001 or WB-005
 */
export function validateEvent(event, config) {
  const missing = [];
  const received = Object.keys(event || {});

  if (!event || typeof event !== 'object') {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: 'Event must be an object',
      received_fields: [],
      missing_fields: ['event_type', 'domain', 'payload'],
    });
  }

  // Check required fields
  if (!event.event_type) missing.push('event_type');
  if (!event.domain) missing.push('domain');
  if (event.payload === undefined || event.payload === null) missing.push('payload');

  if (missing.length > 0) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: `Missing required fields: ${missing.join(', ')}`,
      received_fields: received,
      missing_fields: missing,
    });
  }

  // event_type validation
  if (typeof event.event_type !== 'string') {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: 'event_type must be a string',
      received_fields: received,
      violation: 'event_type must be a string',
    });
  }
  if (event.event_type.length > 128) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: `event_type exceeds 128 chars (got ${event.event_type.length})`,
      received_fields: received,
      violation: 'event_type exceeds 128 chars',
    });
  }
  if (!EVENT_TYPE_REGEX.test(event.event_type)) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: `event_type does not match pattern: ${EVENT_TYPE_REGEX}`,
      received_fields: received,
      violation: `event_type must match ${EVENT_TYPE_REGEX}`,
    });
  }

  // domain validation
  if (typeof event.domain !== 'string') {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: 'domain must be a string',
      received_fields: received,
      violation: 'domain must be a string',
    });
  }
  if (event.domain.length > 64) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: `domain exceeds 64 chars (got ${event.domain.length})`,
      received_fields: received,
      violation: 'domain exceeds 64 chars',
    });
  }

  // subdomain validation (optional, defaults to '')
  if (event.subdomain !== undefined && event.subdomain !== null) {
    if (typeof event.subdomain !== 'string') {
      throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
        message: 'subdomain must be a string',
        received_fields: received,
        violation: 'subdomain must be a string',
      });
    }
    if (event.subdomain.length > 64) {
      throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
        message: `subdomain exceeds 64 chars (got ${event.subdomain.length})`,
        received_fields: received,
        violation: 'subdomain exceeds 64 chars',
      });
    }
  }

  // payload validation
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    // If it's a string, try to parse it
    if (typeof event.payload === 'string') {
      try {
        const parsed = JSON.parse(event.payload);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
      } catch (_) {
        throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
          message: 'payload must be a valid JSON object',
          received_fields: received,
          violation: 'payload must be a valid JSON object',
        });
      }
    } else {
      throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
        message: 'payload must be a valid JSON object',
        received_fields: received,
        violation: 'payload must be a valid JSON object',
      });
    }
  }

  // Payload size check
  const payloadStr = typeof event.payload === 'string'
    ? event.payload
    : JSON.stringify(event.payload);
  const payloadBytes = Buffer.byteLength(payloadStr, 'utf8');
  if (payloadBytes > config.max_payload_bytes) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: `Payload size ${payloadBytes} bytes exceeds max_payload_bytes (${config.max_payload_bytes})`,
      received_fields: received,
      violation: 'payload exceeds max_payload_bytes',
    });
  }

  // schema_version validation (if present)
  if (event.schema_version !== undefined && event.schema_version !== null) {
    if (typeof event.schema_version !== 'string' || !SEMVER_REGEX.test(event.schema_version)) {
      throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
        message: 'schema_version must be a valid semver string (e.g. 1.0.0)',
        received_fields: received,
        violation: 'invalid schema_version format',
      });
    }
    const major = parseInt(event.schema_version.split('.')[0], 10);
    if (major > 1) {
      throw new WBError('WB-005', 'SCHEMA_VERSION_UNSUPPORTED', {
        message: `schema_version ${event.schema_version} is not supported (max 1.x)`,
        declared: event.schema_version,
        max_supported: '1.x',
      });
    }
  }
}
