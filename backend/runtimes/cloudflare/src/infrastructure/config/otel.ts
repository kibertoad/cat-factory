import {
  parseLogExportBatchSize,
  parseLogExportFlushIntervalMs,
  parseOtlpHeaders,
  parsePlatformMetricsIntervalMs,
  parsePlatformMetricsWindow,
} from '@cat-factory/observability-otel'
import type { OtelConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { OtelConfig }

/**
 * OpenTelemetry OTLP exporter config. Opt-in: off unless `OTEL_ENABLED=true` AND
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set (a half-configured exporter silently does nothing,
 * like the other opt-in integrations). `platformMetrics` and `logs` are further opt-ins on
 * top: the deployment-level metrics sweep the `scheduled` cron drives, and the OTLP log
 * export. The Worker is cron-driven and flushes logs at the end of each invocation, so both
 * interval values are carried for type-parity but unused here.
 */
export function loadOtelConfig(env: Env): OtelConfig {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  const enabled = env.OTEL_ENABLED?.trim() === 'true' && !!endpoint
  return {
    enabled,
    endpoint: endpoint || undefined,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || undefined,
    platformMetrics: {
      enabled: enabled && env.OTEL_PLATFORM_METRICS?.trim() === 'true',
      intervalMs: parsePlatformMetricsIntervalMs(env.OTEL_PLATFORM_METRICS_INTERVAL_MS),
      window: parsePlatformMetricsWindow(env.OTEL_PLATFORM_METRICS_WINDOW),
    },
    logs: {
      enabled: enabled && env.OTEL_LOGS?.trim() === 'true',
      flushIntervalMs: parseLogExportFlushIntervalMs(env.OTEL_LOGS_FLUSH_INTERVAL_MS),
      maxBatchSize: parseLogExportBatchSize(env.OTEL_LOGS_MAX_BATCH_SIZE),
    },
  }
}
