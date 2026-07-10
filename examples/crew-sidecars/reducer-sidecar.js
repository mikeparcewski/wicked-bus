/**
 * reducer-sidecar — the wicked-crew "reducer".
 *
 * Subscribes to `wicked.run.*` and reacts to `wicked.run.requested`
 * ({ workflow, problem, args }) by launching (here: stub-recording) a run.
 *
 *   - IDEMPOTENT: a re-delivered `requested` event is handled exactly once
 *     (dedupe on idempotency_key, persisted in the state file).
 *   - DURABLE CURSOR: registers once, then resumes from the persisted cursor
 *     across restarts instead of re-registering.
 *
 * Run standalone (polls every second until SIGINT):
 *   WICKED_BUS_DATA_DIR=/tmp/crew node examples/crew-sidecars/reducer-sidecar.js
 *
 * Or drive a single cycle from a test via `makeReducer().tick()`.
 */

import { createSidecar, log } from './crew-sidecar.js';

export function makeReducer(deps = {}) {
  return createSidecar(
    {
      name: 'crew-reducer',
      filter: 'wicked.run.*', // single-level: matches wicked.run.requested / .failed / .completed
      cursorInit: 'oldest',
      handle({ event, payload, sidecar }) {
        // Only `requested` launches a run; other wicked.run.* events are
        // observed (acked) but not acted on by the reducer.
        if (event.event_type !== 'wicked.run.requested') {
          log('crew-reducer', `ignoring ${event.event_type} #${event.event_id}`);
          return;
        }

        const runId = payload.run_id || `run-${event.event_id}`;
        log('crew-reducer', `launching run ${runId} workflow=${payload.workflow} problem=${JSON.stringify(payload.problem)}`);

        // Stub "record" — in the real engine this would materialize run state.
        sidecar.state.records.push({
          run_id: runId,
          workflow: payload.workflow,
          problem: payload.problem,
          args: payload.args || {},
          source_event_id: event.event_id,
          launched_at: Date.now(),
        });
      },
    },
    deps
  );
}

// ── standalone runner ──────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const reducer = makeReducer();
  const { resumed } = reducer.ensureRegistered();
  log('crew-reducer', `started (${resumed ? 'resumed' : 'fresh register'}) cursor=${reducer.state.cursor_id}`);

  const interval = setInterval(() => {
    try {
      const r = reducer.tick({ batchSize: 50 });
      if (r.handled || r.skipped) {
        log('crew-reducer', `tick handled=${r.handled} skipped=${r.skipped} ackedTo=${r.ackedTo}`);
      }
    } catch (err) {
      log('crew-reducer', `tick error: ${err.error || ''} ${err.message}`);
    }
  }, 1000);

  const shutdown = () => {
    clearInterval(interval);
    reducer.close();
    log('crew-reducer', 'stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
