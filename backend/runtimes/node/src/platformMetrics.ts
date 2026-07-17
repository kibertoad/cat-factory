import type { Clock, WorkspaceRepository } from '@cat-factory/kernel'
import {
  type PlatformObservabilityService,
  distinctAccountIds,
  sweepPlatformMetrics,
} from '@cat-factory/orchestration'
import { createPlatformMetricsOtelExporter } from '@cat-factory/observability-otel'
import type { Logger, OtelConfig } from '@cat-factory/server'
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
): () => void {
  const { otel, platformObservability, workspaceRepository } = deps
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
    failureMessage: 'platform metrics sweep failed',
    tick: async () => {
      const exported = await sweepPlatformMetrics({
        listAccountIds: async () => distinctAccountIds(await workspaceRepository.listVisible(null)),
        summarize: (accountId, window) => platformObservability.summarize(accountId, window),
        sink: exporter,
        window: otel.platformMetrics.window,
        logger: log,
      })
      if (exported > 0) log.info({ exported }, 'exported platform metrics')
    },
  })
}
