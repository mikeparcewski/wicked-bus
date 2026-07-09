/**
 * skill-provisioner-sidecar — the wicked-crew "skill provisioner".
 *
 * Subscribes to EXACTLY `wicked.skill.needed` (a precise, non-wildcard filter,
 * so it never consumes its own `wicked.skill.ready` emissions), "installs" the
 * requested skill (stub), and emits `wicked.skill.ready` carrying the
 * correlation id (run_id) from the needed event.
 *
 *   - Correlation is propagated two ways: `correlation_id` on the event row AND
 *     `run_id` in the ready payload, so a consumer can join on either.
 *   - The ready emit uses a DETERMINISTIC idempotency_key
 *     (`skill-ready:<run_id>:<skill>`), so even if the needed event is
 *     re-delivered the bus rejects the duplicate ready (WB-002) rather than
 *     producing two — belt-and-suspenders on top of the handler-level dedupe.
 *
 * Run standalone:
 *   WICKED_BUS_DATA_DIR=/tmp/crew node examples/crew-sidecars/skill-provisioner-sidecar.js
 */

import { createSidecar, log } from './crew-sidecar.js';

export function makeProvisioner(deps = {}) {
  return createSidecar(
    {
      name: 'crew-skill-provisioner',
      filter: 'wicked.skill.needed', // exact match — will NOT match wicked.skill.ready
      cursorInit: 'oldest',
      handle({ event, payload, sidecar }) {
        const runId = payload.run_id || event.correlation_id || `run-${event.event_id}`;
        const skill = payload.skill || payload.name || 'unknown-skill';

        log('crew-skill-provisioner', `installing skill "${skill}" for run ${runId}`);
        // Stub install — the real engine would resolve + provision the skill here.
        const installedAt = Date.now();

        sidecar.state.records.push({ run_id: runId, skill, installed_at: installedAt });

        const res = sidecar.emit({
          event_type: 'wicked.skill.ready',
          domain: 'wicked-crew',
          subdomain: 'skill.provisioner',
          idempotency_key: `skill-ready:${runId}:${skill}`,
          correlation_id: runId,
          payload: {
            run_id: runId,
            skill,
            installed: true,
            installed_at: installedAt,
            source_event_id: event.event_id,
          },
        });

        log(
          'crew-skill-provisioner',
          `emitted wicked.skill.ready run=${runId} skill=${skill} ` +
            `event_id=${res.event_id}${res.duplicate ? ' (duplicate suppressed)' : ''}`
        );
      },
    },
    deps
  );
}

// ── standalone runner ──────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const prov = makeProvisioner();
  const { resumed } = prov.ensureRegistered();
  log('crew-skill-provisioner', `started (${resumed ? 'resumed' : 'fresh register'}) cursor=${prov.state.cursor_id}`);

  const interval = setInterval(() => {
    try {
      const r = prov.tick({ batchSize: 50 });
      if (r.handled || r.skipped) {
        log('crew-skill-provisioner', `tick handled=${r.handled} skipped=${r.skipped} ackedTo=${r.ackedTo}`);
      }
    } catch (err) {
      log('crew-skill-provisioner', `tick error: ${err.error || ''} ${err.message}`);
    }
  }, 1000);

  const shutdown = () => {
    clearInterval(interval);
    prov.close();
    log('crew-skill-provisioner', 'stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
