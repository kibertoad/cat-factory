import type { PlatformObservability } from '@cat-factory/contracts'
import {
  type MappedGauge,
  ATTR,
  DEFAULT_SERVICE_NAME,
  SCOPE_NAME,
  mapPlatformMetrics,
  toUnixNano,
} from './mapping.js'
import { type KeyValue, type OtlpLogger, keyValues, postOtlp } from './otlp.js'

// A fetch-based OpenTelemetry exporter for the DEPLOYMENT-LEVEL (platform-operator)
// observability aggregates — the dual of the per-run LLM exporter in `./index`. A periodic
// sweep (Worker `scheduled` cron ⇄ Node interval, runtime-symmetric) computes the
// `PlatformObservability` projection per account and hands it here; this encodes it as OTLP
// GAUGE metrics and POSTs to `{endpoint}/v1/metrics`, so an operator watches run
// success/failure rates, live/parked depth, failure taxonomy and duration percentiles in
// their own OTLP backend (Grafana Mimir, Datadog, an OpenTelemetry Collector, …).
//
// It is the FETCH transport on BOTH runtimes (unlike the per-call LLM path, which uses the
// official SDK on Node): the platform push is a stateless, low-frequency snapshot POST with
// no need for the SDK's async instruments / periodic reader / batching, so one workerd-safe
// exporter serves both facades and is tested once — mirroring the Langfuse sink's fetch-on-
// both shape. It depends only on the `fetch`/`crypto` globals; never on `@opentelemetry/*`.
//
// Contract (identical to every trace sink): observability must never break the product, so
// the POST is best-effort (errors logged, never thrown) and bounded by a timeout — a dropped
// batch degrades telemetry completeness only, never the sweep or any run.

export interface PlatformMetricsOtelExporterConfig {
  /** OTLP/HTTP base URL, e.g. `http://collector:4318` (`/v1/metrics` is appended). */
  endpoint: string
  /** Extra headers merged onto every request (auth tokens, tenant ids, …). */
  headers?: Record<string, string>
  /** OTLP resource `service.name`; defaults to `cat-factory`. */
  serviceName?: string
  /** Optional logger for swallowed errors. */
  logger?: OtlpLogger
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Encode one {@link MappedGauge} as an OTLP metric with a `gauge` data-point list. */
function encodeGauge(gauge: MappedGauge, timeUnixNano: string): Record<string, unknown> {
  return {
    name: gauge.name,
    unit: gauge.unit,
    gauge: {
      dataPoints: gauge.points.map((point) => ({
        attributes: keyValues(point.attributes),
        timeUnixNano,
        ...(point.isInt ? { asInt: String(Math.round(point.value)) } : { asDouble: point.value }),
      })),
    },
  }
}

export class PlatformMetricsOtelExporter {
  private readonly metricsEndpoint: string
  private readonly headers: Record<string, string>
  private readonly serviceName: string
  private readonly logger?: OtlpLogger
  private readonly fetchImpl: typeof fetch

  constructor(config: PlatformMetricsOtelExporterConfig) {
    const base = config.endpoint.replace(/\/+$/, '')
    this.metricsEndpoint = `${base}/v1/metrics`
    this.headers = { 'content-type': 'application/json', ...config.headers }
    this.serviceName = config.serviceName || DEFAULT_SERVICE_NAME
    this.logger = config.logger
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  private resourceAttributes(): KeyValue[] {
    return [{ key: ATTR.serviceName, value: { stringValue: this.serviceName } }]
  }

  /**
   * Export one account's platform-observability snapshot as OTLP gauge metrics. Gauges are
   * stamped with the snapshot's `generatedAt` (the clock the projection was computed at), so
   * no wall-clock read is needed here. A snapshot that yields no gauges (nothing to report)
   * is skipped rather than POSTing an empty batch. Best-effort — see the file header.
   */
  async export(snapshot: PlatformObservability, dims: { accountId: string }): Promise<void> {
    const gauges = mapPlatformMetrics(snapshot, dims)
    if (gauges.length === 0) return
    const timeUnixNano = toUnixNano(snapshot.generatedAt)
    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeMetrics: [
            {
              scope: { name: SCOPE_NAME },
              metrics: gauges.map((gauge) => encodeGauge(gauge, timeUnixNano)),
            },
          ],
        },
      ],
    }
    await postOtlp({
      fetchImpl: this.fetchImpl,
      endpoint: this.metricsEndpoint,
      headers: this.headers,
      payload,
      logger: this.logger,
    })
  }
}

/** Build a fetch-based {@link PlatformMetricsOtelExporter}. The workerd-safe opt-in exporter. */
export function createPlatformMetricsOtelExporter(
  config: PlatformMetricsOtelExporterConfig,
): PlatformMetricsOtelExporter {
  return new PlatformMetricsOtelExporter(config)
}
