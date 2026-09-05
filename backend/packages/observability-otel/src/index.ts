import type {
  LlmGenerationEvent,
  LlmRunSpan,
  LlmStepSpan,
  LlmToolSpan,
  LlmToolSpanContext,
  LlmTraceSink,
  Logger,
} from '@cat-factory/kernel'
import {
  type MappedSpan,
  ATTR,
  DEFAULT_SERVICE_NAME,
  DURATION_UNIT,
  METRIC,
  SCOPE_NAME,
  TOKEN_UNIT,
  mapGeneration,
  mapGenerationMetrics,
  mapRunSpan,
  mapStepSpan,
  mapToolSpan,
  toUnixNano,
} from './mapping.js'
import { type KeyValue, keyValues, postOtlp } from './otlp.js'
import { DEFAULT_LOG_BATCH_SIZE } from './logs.js'

// A fetch-based OpenTelemetry exporter that speaks OTLP/HTTP with the **JSON** encoding
// (`POST {endpoint}/v1/traces` and `/v1/metrics`) using only the global `fetch`/`crypto`.
// It deliberately does NOT depend on `@opentelemetry/*` — the SDK relies on Node-only APIs
// unavailable on the Cloudflare Worker runtime (workerd), exactly as the Langfuse sink
// avoids them. This keeps the exporter byte-for-byte identical on the Worker and, if ever
// desired, Node; the Node facade instead uses the official-SDK exporter in `./node`, kept
// conformant with this one by the shared `./mapping` layer + `conformity.test.ts`.
//
// Contract (identical to the Langfuse sink): observability must never break the product,
// so every method swallows its own errors (logging at most a warning) and each POST is
// bounded by a timeout — a dropped batch is the documented best-effort worst case. One
// POST per call keeps the exporter stateless (no cross-request buffer to flush), which is
// the only shape that survives the Worker's per-request isolate lifecycle. Metrics are
// emitted with DELTA temporality so a single call is a valid, self-contained data point.

/** OTLP `AggregationTemporality.DELTA` (proto enum value). */
const TEMPORALITY_DELTA = 1
/** OTLP span-kind proto enum values, per the neutral kind the mapping layer decides. */
const SPAN_KIND: Record<MappedSpan['kind'], number> = { internal: 1, client: 3 }
/** OTLP status codes: UNSET / ERROR. */
const STATUS_UNSET = 0
const STATUS_ERROR = 2

export interface OtelSinkConfig {
  /** OTLP/HTTP base URL, e.g. `http://collector:4318` (the `/v1/*` paths are appended). */
  endpoint: string
  /**
   * Whether the destination takes `/v1/metrics` as well as `/v1/traces`. Default true.
   *
   * Not every OTLP endpoint is a general collector: a trace BACKEND may implement the traces
   * signal alone (Langfuse does), and posting metrics there earns a 404 per generation. Off means
   * the metrics payload is never built, rather than built and dropped.
   */
  exportMetrics?: boolean
  /** Extra headers merged onto every request (auth tokens, tenant ids, …). */
  headers?: Record<string, string>
  /** OTLP resource `service.name`; defaults to `cat-factory`. */
  serviceName?: string
  /** Optional logger for swallowed errors. */
  logger?: Logger
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

// ---- OTLP/JSON encoding helpers -------------------------------------------

function encodeSpan(span: MappedSpan): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: SPAN_KIND[span.kind],
    startTimeUnixNano: toUnixNano(span.startTimeMs),
    endTimeUnixNano: toUnixNano(span.endTimeMs),
    attributes: keyValues(span.attributes),
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: toUnixNano(e.timeMs),
      attributes: keyValues(e.attributes),
    })),
    status: span.ok
      ? { code: STATUS_UNSET }
      : { code: STATUS_ERROR, ...(span.statusMessage ? { message: span.statusMessage } : {}) },
  }
}

export class OtelTraceSink implements LlmTraceSink {
  private readonly tracesEndpoint: string
  private readonly metricsEndpoint: string | null
  private readonly headers: Record<string, string>
  private readonly serviceName: string
  private readonly logger?: Logger
  private readonly fetchImpl: typeof fetch

  constructor(config: OtelSinkConfig) {
    const base = config.endpoint.replace(/\/+$/, '')
    this.tracesEndpoint = `${base}/v1/traces`
    this.metricsEndpoint = config.exportMetrics === false ? null : `${base}/v1/metrics`
    this.headers = { 'content-type': 'application/json', ...config.headers }
    this.serviceName = config.serviceName || DEFAULT_SERVICE_NAME
    this.logger = config.logger
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  private resourceAttributes(): KeyValue[] {
    return [{ key: ATTR.serviceName, value: { stringValue: this.serviceName } }]
  }

  async recordGeneration(event: LlmGenerationEvent): Promise<void> {
    const span = mapGeneration(event)
    // Traces and metrics go to distinct OTLP endpoints (two POSTs), each best-effort.
    await Promise.all([
      this.sendSpans([span]),
      this.metricsEndpoint ? this.sendMetrics(mapGenerationMetrics(event)) : Promise.resolve(),
    ])
  }

  async recordToolSpans(context: LlmToolSpanContext, spans: LlmToolSpan[]): Promise<void> {
    // Tool spans are only meaningful as children of a run's trace.
    if (!context.executionId || spans.length === 0) return
    await this.sendSpans(spans.map((span) => mapToolSpan(context, span)))
  }

  /**
   * The settled run's root + step spans, in ONE POST: they are the parents the run's already
   * exported generations and tool spans named, so splitting them across requests would let a
   * partial failure leave a trace whose steps point at a root that never arrives.
   */
  async recordRunSpans(run: LlmRunSpan, steps: LlmStepSpan[]): Promise<void> {
    await this.sendSpans([mapRunSpan(run), ...steps.map(mapStepSpan)])
  }

  private async sendSpans(spans: MappedSpan[]): Promise<void> {
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeSpans: [
            {
              scope: { name: SCOPE_NAME },
              spans: spans.map(encodeSpan),
            },
          ],
        },
      ],
    }
    await this.send(this.tracesEndpoint, payload)
  }

  private async sendMetrics(metrics: ReturnType<typeof mapGenerationMetrics>): Promise<void> {
    if (!this.metricsEndpoint) return
    const startNano = toUnixNano(metrics.startTimeMs)
    const timeNano = toUnixNano(metrics.endTimeMs)
    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeMetrics: [
            {
              scope: { name: SCOPE_NAME },
              metrics: [
                {
                  name: METRIC.tokenUsage,
                  unit: TOKEN_UNIT,
                  sum: {
                    aggregationTemporality: TEMPORALITY_DELTA,
                    isMonotonic: true,
                    dataPoints: metrics.tokenUsage.map((point) => ({
                      attributes: keyValues(point.attributes),
                      startTimeUnixNano: startNano,
                      timeUnixNano: timeNano,
                      asInt: String(point.value),
                    })),
                  },
                },
                {
                  name: METRIC.duration,
                  unit: DURATION_UNIT,
                  histogram: {
                    aggregationTemporality: TEMPORALITY_DELTA,
                    dataPoints: [
                      {
                        attributes: keyValues(metrics.durationAttributes),
                        startTimeUnixNano: startNano,
                        timeUnixNano: timeNano,
                        count: '1',
                        sum: metrics.durationSeconds,
                        // A single observation: one implicit bucket, no explicit bounds.
                        bucketCounts: ['1'],
                        explicitBounds: [],
                        min: metrics.durationSeconds,
                        max: metrics.durationSeconds,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    await this.send(this.metricsEndpoint, payload)
  }

  private async send(endpoint: string, payload: unknown): Promise<void> {
    await postOtlp({
      fetchImpl: this.fetchImpl,
      endpoint,
      headers: this.headers,
      payload,
      logger: this.logger,
    })
  }
}

/** Build a fetch-based {@link OtelTraceSink}. The workerd-safe opt-in OTLP exporter. */
export function createOtelSink(config: OtelSinkConfig): OtelTraceSink {
  return new OtelTraceSink(config)
}

// The deployment-level (platform-operator) metrics exporter — the dual of the per-run LLM
// sink above. Fetch-based on both runtimes (see `./platform`), so it lives in this
// workerd-safe entry rather than the SDK `./node` one.
export {
  PlatformMetricsOtelExporter,
  type PlatformMetricsOtelExporterConfig,
  createPlatformMetricsOtelExporter,
} from './platform.js'

// The LOG exporter (`/v1/logs`): the kernel `LogSink` the server's logging adapter fans
// emitted lines into. Fetch-based on both runtimes like the platform exporter (see `./logs`),
// so it too lives in this workerd-safe entry rather than the SDK `./node` one.
export {
  DEFAULT_LOG_BATCH_SIZE,
  OtelLogExporter,
  type OtelLogExporterConfig,
  SELF_LOG_FIELD,
  createOtelLogExporter,
} from './logs.js'

/**
 * Parse the OTLP `OTEL_EXPORTER_OTLP_HEADERS` convention — comma-separated `key=value`
 * pairs (e.g. `x-api-key=abc,x-tenant=42`) — into a header map, or undefined when
 * unset/empty. Shared by every facade so the two transports read headers identically.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const headers: Record<string, string> = {}
  for (const pair of trimmed.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (key) headers[key] = value
  }
  return Object.keys(headers).length ? headers : undefined
}

// ---- platform-metrics sweep config parsing (shared by both facades) --------

/** Default platform-metrics sweep interval (Node timer); the Worker is cron-driven. */
export const PLATFORM_METRICS_DEFAULT_INTERVAL_MS = 60_000

/** The trailing windows the platform-metrics sweep may aggregate over. */
export const PLATFORM_METRICS_WINDOWS = ['1h', '24h', '7d'] as const
export type PlatformMetricsWindow = (typeof PLATFORM_METRICS_WINDOWS)[number]

/** A positive integer read off an env var, or `fallback` when unset, non-numeric or not positive. */
function positiveIntegerOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Parse `OTEL_PLATFORM_METRICS_INTERVAL_MS` into a positive integer ms, falling back to
 * {@link PLATFORM_METRICS_DEFAULT_INTERVAL_MS} for unset / non-numeric / non-positive values.
 * Shared by every facade so the sweep cadence is parsed identically.
 */
export function parsePlatformMetricsIntervalMs(raw: string | undefined): number {
  return positiveIntegerOr(raw, PLATFORM_METRICS_DEFAULT_INTERVAL_MS)
}

/**
 * Parse `OTEL_PLATFORM_METRICS_WINDOW` into a valid trailing window, defaulting to `1h`
 * (the shortest, most operationally useful — the OTel backend builds longer trends from the
 * gauge series). Shared so both facades default + validate identically.
 */
export function parsePlatformMetricsWindow(raw: string | undefined): PlatformMetricsWindow {
  const w = raw?.trim()
  return w === '24h' || w === '7d' ? w : '1h'
}

// ---- log-export config parsing (shared by both facades) -------------------

/**
 * Default log-export flush cadence (Node timer). Short enough that a line is queryable while
 * an operator is still watching the incident that produced it, long enough that a busy
 * deployment batches rather than posting per line. The Worker flushes per invocation instead,
 * so this does not apply there.
 */
export const LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS = 5_000

/**
 * Parse `OTEL_LOGS_FLUSH_INTERVAL_MS` into a positive integer ms, falling back to
 * {@link LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS} for unset / non-numeric / non-positive values.
 */
export function parseLogExportFlushIntervalMs(raw: string | undefined): number {
  return positiveIntegerOr(raw, LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS)
}

/**
 * Parse `OTEL_LOGS_MAX_BATCH_SIZE` into a positive integer, falling back to
 * {@link DEFAULT_LOG_BATCH_SIZE}. It bounds both the POST size and (with the exporter's queue
 * multiplier) how much a collector outage may hold in memory, so an operator turning it up
 * for a chatty deployment is raising both together, deliberately.
 */
export function parseLogExportBatchSize(raw: string | undefined): number {
  return positiveIntegerOr(raw, DEFAULT_LOG_BATCH_SIZE)
}
