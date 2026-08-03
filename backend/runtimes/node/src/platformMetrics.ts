import type {
  Clock,
  OperationalGaugeSample,
  OperationalMetricsCollector,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  type PlatformObservabilityService,
  distinctAccountIds,
  flushOperationalMetrics,
  sweepPlatformMetrics,
} from '@cat-factory/orchestration'
import { createPlatformMetricsOtelExporter } from '@cat-factory/observability-otel'
import type { Logger, OtelConfig, SweepHealthTracker } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Node analogue of the Worker's platform-metrics cron branch: a periodic sweep that pushes
// the deployment-level (platform-operator) observability aggregates per account to the OTLP
// endpoint as OpenTelemetry gauge metrics. Opt-in on top of the base OTel exporter
// (`OTEL_PLATFORM_METRICS`). Kept symmetric with the Worker — same fetch-based exporter,
// same shared `sweepPlatformMetrics` driver, same account enumeration from the workspace
// projection (`listVisible(null)` → distinct account ids).

export interface PlatformMetricsSweeperDeps {
  otel: OtelConfig
  platformObservability: PlatformObservabilityService
  workspaceRepository: Pick<WorkspaceRepository, 'listVisible'>
  /**
   * Reads every pg-boss queue's depth in ONE call. Omitted ⇒ no queue gauge is emitted at
   * all, which is the honest answer for a deployment with no durable substrate (mothership
   * mode) — a zero there would claim an empty queue where there is no queue.
   */
  probeQueueDepth?: () => Promise<OperationalGaugeSample[]>
}

/**
 * Start the periodic platform-metrics push. A NO-OP (returns a no-op stop) unless the base
 * OTel exporter is configured (endpoint present) AND `platformMetrics.enabled` — so a
 * deployment that hasn't opted in pays nothing. Runs once immediately then on the configured
 * interval; best-effort per account (a failed summarize/export is logged, never thrown).
 * Returns a stop function to halt the job on shutdown.
 */
export function startPlatformMetricsSweeper(
  deps: PlatformMetricsSweeperDeps,
  clock: Clock,
  log: Logger,
  /**
   * The process-wide collector, DRAINED by this sweep. Node holds ONE for the life of the
   * process, so draining on this interval loses nothing; the Worker cannot do the same and
   * flushes per invocation.
   */
  metrics: OperationalMetricsCollector,
  /** Records each pass's outcome under this sweep's name (see {@link startSweeper}). */
  health: SweepHealthTracker,
): () => void {
  const { otel, platformObservability, workspaceRepository, probeQueueDepth } = deps
  if (!otel.platformMetrics.enabled || !otel.endpoint) return () => {}

  const exporter = createPlatformMetricsOtelExporter({
    endpoint: otel.endpoint,
    headers: otel.headers,
    serviceName: otel.serviceName,
    logger: log,
  })

  return startSweeper({
    name: 'platform-metrics',
    intervalMs: otel.platformMetrics.intervalMs,
    log,
    health,
    failureMessage: 'platform metrics sweep failed',
    tick: async () => {
      const exported = await sweepPlatformMetrics({
        listAccountIds: async () => distinctAccountIds(await workspaceRepository.listVisible(null)),
        summarize: (accountId, window) => platformObservability.summarize(accountId, window),
        sink: exporter,
        window: otel.platformMetrics.window,
        logger: log,
      })
      if (exported > 0) log.info('exported platform metrics', { exported })
      // The OPERATIONAL half, on the same tick and through the same exporter: the counters
      // this process accumulated since the last flush, plus a live queue-depth reading.
      const flushed = await flushOperationalMetrics({
        collector: metrics,
        sink: exporter,
        ...(probeQueueDepth ? { probeGauges: probeQueueDepth } : {}),
        now: clock.now(),
        logger: log,
      })
      if (flushed > 0) log.debug('exported operational metrics', { samples: flushed })
    },
  })
}
