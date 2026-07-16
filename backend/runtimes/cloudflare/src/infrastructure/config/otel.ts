import { parseOtlpHeaders } from '@cat-factory/observability-otel'
import type { OtelConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { OtelConfig }

/**
 * OpenTelemetry OTLP exporter config. Opt-in: off unless `OTEL_ENABLED=true` AND
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set (a half-configured exporter silently does nothing,
 * like the other opt-in integrations).
 */
export function loadOtelConfig(env: Env): OtelConfig {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  const enabled = env.OTEL_ENABLED?.trim() === 'true' && !!endpoint
  return {
    enabled,
    endpoint: endpoint || undefined,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || undefined,
  }
}
