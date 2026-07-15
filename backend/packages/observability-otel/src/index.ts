import type {
  LlmGenerationEvent,
  LlmToolSpan,
  LlmToolSpanContext,
  LlmTraceSink,
} from '@cat-factory/kernel'
import {
  type AttributeMap,
  type AttributeValue,
  type MappedSpan,
  ATTR,
  DEFAULT_SERVICE_NAME,
  DURATION_UNIT,
  METRIC,
  SCOPE_NAME,
  TOKEN_UNIT,
  mapGeneration,
  mapGenerationMetrics,
  mapToolSpan,
  randomSpanId,
  toUnixNano,
} from './mapping.js'

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

/** Hard ceiling on a single OTLP POST, so a hung collector can't tie up the caller. */
const SEND_TIMEOUT_MS = 10_000

/** OTLP `AggregationTemporality.DELTA` (proto enum value). */
const TEMPORALITY_DELTA = 1
/** OTLP span kind CLIENT / INTERNAL (proto enum values). */
const SPAN_KIND_CLIENT = 3
const SPAN_KIND_INTERNAL = 1
/** OTLP status codes: UNSET / ERROR. */
const STATUS_UNSET = 0
const STATUS_ERROR = 2

/** Minimal structured logger (pino-compatible); optional. */
export interface OtelLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

export interface OtelSinkConfig {
  /** OTLP/HTTP base URL, e.g. `http://collector:4318` (the `/v1/*` paths are appended). */
  endpoint: string
  /** Extra headers merged onto every request (auth tokens, tenant ids, …). */
  headers?: Record<string, string>
  /** OTLP resource `service.name`; defaults to `cat-factory`. */
  serviceName?: string
  /** Optional logger for swallowed errors. */
  logger?: OtelLogger
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

// ---- OTLP/JSON encoding helpers -------------------------------------------

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }

interface KeyValue {
  key: string
  value: AnyValue
}

function anyValue(value: AttributeValue): AnyValue {
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } }
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  return { stringValue: value }
}

function keyValues(attrs: AttributeMap): KeyValue[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }))
}

function encodeSpan(span: MappedSpan, kind: number): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: randomSpanId(),
    name: span.name,
    kind,
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
  private readonly metricsEndpoint: string
  private readonly headers: Record<string, string>
  private readonly serviceName: string
  private readonly logger?: OtelLogger
  private readonly fetchImpl: typeof fetch

  constructor(config: OtelSinkConfig) {
    const base = config.endpoint.replace(/\/+$/, '')
    this.tracesEndpoint = `${base}/v1/traces`
    this.metricsEndpoint = `${base}/v1/metrics`
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
    const metrics = mapGenerationMetrics(event)
    // Traces and metrics go to distinct OTLP endpoints (two POSTs), each best-effort.
    await Promise.all([this.sendSpans([span], SPAN_KIND_CLIENT), this.sendMetrics(metrics)])
  }

  async recordToolSpans(context: LlmToolSpanContext, spans: LlmToolSpan[]): Promise<void> {
    // Tool spans are only meaningful as children of a run's trace.
    if (!context.executionId || spans.length === 0) return
    await this.sendSpans(
      spans.map((span) => mapToolSpan(context, span)),
      SPAN_KIND_INTERNAL,
    )
  }

  private async sendSpans(spans: MappedSpan[], kind: number): Promise<void> {
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeSpans: [
            {
              scope: { name: SCOPE_NAME },
              spans: spans.map((span) => encodeSpan(span, kind)),
            },
          ],
        },
      ],
    }
    await this.send(this.tracesEndpoint, payload)
  }

  private async sendMetrics(metrics: ReturnType<typeof mapGenerationMetrics>): Promise<void> {
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
    try {
      const res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        // Bound the request so a hung collector can't tie up the caller's budget; an abort
        // lands in the catch below and drops the batch (best-effort).
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      // OTLP/HTTP returns 200 on full success and may return 200 with a partial-success
      // body; any non-2xx is a failure we only log — observability never breaks the caller.
      if (!res.ok) {
        this.logger?.warn(
          { scope: 'otel', status: res.status },
          'otel: OTLP endpoint rejected batch',
        )
      }
    } catch (err) {
      this.logger?.warn(
        { scope: 'otel', err: err instanceof Error ? err.message : String(err) },
        'otel: failed to POST OTLP batch',
      )
    }
  }
}

/** Build a fetch-based {@link OtelTraceSink}. The workerd-safe opt-in OTLP exporter. */
export function createOtelSink(config: OtelSinkConfig): OtelTraceSink {
  return new OtelTraceSink(config)
}

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
