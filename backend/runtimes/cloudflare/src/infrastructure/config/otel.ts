import {
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
 * like the other opt-in integrations). `platformMetrics` is a further opt-in on top,
 * gating the deployment-level metrics sweep the `scheduled` cron drives — the Worker is
 * cron-driven, so its `intervalMs` is carried for type-parity but unused.
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
  }
}
