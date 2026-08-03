import { operationalMetrics } from '@cat-factory/server'
import type { Clock, Logger } from '@cat-factory/kernel'
import type { MachineTelemetryClient, RetentionConfig } from '@cat-factory/server'
import type { LocalTelemetryStore } from './sqlite/telemetryStore.js'
import { startTelemetryIngest } from './telemetryIngest.js'
import { startLocalTelemetryRetention } from './telemetryRetention.js'

// The two background sweeps a mothership-mode node runs over its LOCAL telemetry store
// (docs/initiatives/mothership-mode.md, PR 5). They are started and stopped together because they
// share ONE lifecycle constraint: both hold the SQLite handle `composeMothership` opened, so both
// must have finished touching it before the facade's `onShutdown` closes it. Composing them here
// keeps that pairing in one place instead of two parallel start/stop threads through
// `buildLocalContainer`.

export interface MothershipTelemetrySweepDeps {
  store: LocalTelemetryStore
  client: MachineTelemetryClient
  retention: RetentionConfig
  clock: Clock
  log: Logger
}

/**
 * Start the local telemetry PRUNE and the UPSTREAM ingest, returning one stop function that awaits
 * both.
 *
 * - The prune is the only thing bounding the store: the mothership's cron owns ITS tables, and the
 *   Node facade's retention sweeper runs from `start()`, which a mothership-mode boot never calls.
 *   Left unpruned, `llm_call_metrics` — full per-call prompt + response bodies — grows without
 *   bound on the developer's disk.
 * - The ingest is what stops the prune being a DATA LOSS: it carries a quiesced run's rows up to
 *   the mothership, so a run this laptop drove stays readable (by hosted teammates, and by anyone
 *   at all) after the local window passes.
 *
 * The returned stop is ASYNC and must be AWAITED before the store closes — each sweep's first pass
 * is asynchronous, so an un-awaited one dies on "database is not open" and puts a spurious error
 * line on every clean exit.
 */
export function startMothershipTelemetrySweeps(
  deps: MothershipTelemetrySweepDeps,
): () => Promise<void> {
  const stopRetention = startLocalTelemetryRetention(
    deps.store,
    deps.retention,
    deps.clock,
    deps.log,
    operationalMetrics,
  )
  const stopIngest = startTelemetryIngest({
    reader: deps.store.ingestReader,
    client: deps.client,
    clock: deps.clock,
    log: deps.log,
  })
  return async () => {
    await stopRetention()
    await stopIngest()
  }
}
