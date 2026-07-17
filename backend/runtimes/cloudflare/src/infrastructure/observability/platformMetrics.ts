import type { WorkspaceRepository } from '@cat-factory/kernel'
import {
  type PlatformObservabilityService,
  distinctAccountIds,
  sweepPlatformMetrics,
} from '@cat-factory/orchestration'
import { createPlatformMetricsOtelExporter } from '@cat-factory/observability-otel'
import type { Logger, OtelConfig } from '@cat-factory/server'

// Worker analogue of the Node facade's `platformMetrics.ts`: the WIRING that pushes the
// deployment-level (platform-operator) observability aggregates per account to the OTLP
// endpoint as OpenTelemetry gauge metrics. The Worker is cron-driven (the `scheduled`
// handler `ctx.waitUntil`s the returned promise) rather than interval-driven, so this is a
// single sweep pass rather than a long-lived timer — but it composes the SAME shared
// `sweepPlatformMetrics` driver + fetch exporter + account enumeration as Node, so the two
// facades stay symmetric (and the wiring gets a unit test the shared driver can't cover).

export interface WorkerPlatformMetricsDeps {
  otel: OtelConfig
  /** The platform-observability read (present only when the projection repo is wired). */
  platformObservability: Pick<PlatformObservabilityService, 'summarize'> | undefined
  workspaceRepository: Pick<WorkspaceRepository, 'listVisible'>
  logger: Logger
  /** Injectable fetch (tests); defaults to the exporter's global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Run one platform-metrics OTLP sweep pass, returning the in-flight promise for the caller
 * to `ctx.waitUntil`. Returns `null` (nothing scheduled) unless the base OTel exporter is
 * configured (endpoint present) AND `platformMetrics.enabled` AND the platform-observability
 * read is wired — so a deployment that hasn't opted in pays nothing. Best-effort per account
 * and self-logging: the returned promise always resolves (a failed summarize/export is
 * logged, never thrown), so `waitUntil` never sees a rejection.
 */
export function runPlatformMetricsSweep(deps: WorkerPlatformMetricsDeps): Promise<void> | null {
  const { otel, platformObservability, workspaceRepository, logger, fetchImpl } = deps
  if (!otel.platformMetrics.enabled || !otel.endpoint || !platformObservability) return null

  const exporter = createPlatformMetricsOtelExporter({
    endpoint: otel.endpoint,
    headers: otel.headers,
    serviceName: otel.serviceName,
    logger,
    fetchImpl,
  })

  return sweepPlatformMetrics({
    listAccountIds: async () => distinctAccountIds(await workspaceRepository.listVisible(null)),
    summarize: (accountId, window) => platformObservability.summarize(accountId, window),
    sink: exporter,
    window: otel.platformMetrics.window,
    logger,
  })
    .then((exported) => {
      if (exported > 0)
        logger.info({ cron: 'platform-metrics', exported }, 'exported platform metrics')
    })
    .catch((error) =>
      logger.error(
        {
          cron: 'platform-metrics',
          err: error instanceof Error ? error.message : String(error),
        },
        'platform metrics sweep failed',
      ),
    )
}
