/**
 * wicked-bus emit command.
 */

import { readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { emit } from '../lib/emit.js';

export async function cmdEmit(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  // Parse payload -- support @file syntax
  let payload = args.payload;
  if (typeof payload === 'string' && payload.startsWith('@')) {
    const filePath = payload.slice(1);
    payload = readFileSync(filePath, 'utf8');
  }

  // Parse payload as JSON if it's a string
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (_) {
      // Will be caught by validation
    }
  }

  const event = {
    event_type: args.type,
    domain: args.domain,
    subdomain: args.subdomain || '',
    payload,
    schema_version: args['schema-version'] || undefined,
    idempotency_key: args['idempotency-key'] || undefined,
    metadata: args.metadata ? JSON.parse(args.metadata) : undefined,
  };

  if (args['ttl-hours'] != null) {
    event.ttl_hours = Number(args['ttl-hours']);
  }

  const result = emit(db, config, event);
  db.close();

  process.stdout.write(JSON.stringify(result) + '\n');
}
