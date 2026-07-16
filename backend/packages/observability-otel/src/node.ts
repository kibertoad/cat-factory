import {
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api'
import {
  type IdGenerator,
  type SpanProcessor,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
  type MetricReader,
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type {
  LlmGenerationEvent,
  LlmToolSpan,
  LlmToolSpanContext,
  LlmTraceSink,
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
  mapToolSpan,
  randomSpanId,
  randomTraceId,
} from './mapping.js'
import type { OtelLogger } from './index.js'

// The OpenTelemetry exporter built on the OFFICIAL `@opentelemetry/*` SDK — the Node
// facade uses this instead of the fetch exporter in `./index`. It emits the SAME
// telemetry (identical span names, attributes, trace-id grouping, metric names/units)
// because it maps events through the shared `./mapping` layer; `conformity.test.ts` pins
// that equivalence. It is Node-only (the SDK depends on Node APIs unavailable on workerd),
// which is why the Worker facade keeps the fetch exporter — both runtimes get the full
// behaviour, differing only in transport library.
//
// Like every trace sink it MUST NOT throw into its caller: each method is wrapped so a
// tracer/meter failure only logs. Trace grouping is achieved with a custom IdGenerator
// (below) fed the per-run trace id right before each span starts, so a run's calls share
// one trace exactly as the fetch exporter's deterministic derivation does.

export interface NodeOtelSinkConfig {
  /** OTLP/HTTP base URL, e.g. `http://collector:4318` (the `/v1/*` paths are appended). */
  endpoint: string
  /** Extra headers merged onto every OTLP request (auth tokens, tenant ids, …). */
  headers?: Record<string, string>
  /** OTLP resource `service.name`; defaults to `cat-factory`. */
  serviceName?: string
  /** Optional logger for swallowed errors. */
  logger?: OtelLogger
  /** Test seam: override the span processor (e.g. a SimpleSpanProcessor over an in-memory exporter). */
  spanProcessor?: SpanProcessor
  /** Test seam: override the metric reader (e.g. one over an InMemoryMetricExporter). */
  metricReader?: MetricReader
}

/**
 * Forces the trace id of the next span so a run's calls share one trace. The SDK calls
 * `generateTraceId()` synchronously while starting a ROOT span (our spans have no active
 * parent), so we set {@link nextTraceId} immediately before `startSpan` and clear it after.
 */
class RunIdGenerator implements IdGenerator {
  nextTraceId: string | null = null

  generateTraceId(): string {
    return this.nextTraceId ?? randomTraceId()
  }

  generateSpanId(): string {
    return randomSpanId()
  }
}

export class NodeOtelTraceSink implements LlmTraceSink {
  private readonly tracerProvider: NodeTracerProvider
  private readonly meterProvider: MeterProvider
  private readonly idGenerator: RunIdGenerator
  private readonly logger?: OtelLogger
  private readonly startSpanForRun: (
    name: string,
    traceId: string,
    startTimeMs: number,
    kind: SpanKind,
    attributes: Attributes,
  ) => Span
  private readonly tokenCounter: Counter
  private readonly durationHistogram: Histogram

  constructor(config: NodeOtelSinkConfig) {
    const base = config.endpoint.replace(/\/+$/, '')
    const headers = config.headers
    const resource = resourceFromAttributes({
      [ATTR.serviceName]: config.serviceName || DEFAULT_SERVICE_NAME,
    })

    this.idGenerator = new RunIdGenerator()
    this.logger = config.logger

    const spanProcessor =
      config.spanProcessor ??
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }))
    this.tracerProvider = new NodeTracerProvider({
      resource,
      idGenerator: this.idGenerator,
      spanProcessors: [spanProcessor],
    })
    const tracer = this.tracerProvider.getTracer(SCOPE_NAME)
    this.startSpanForRun = (name, traceId, startTimeMs, kind, attributes) => {
      this.idGenerator.nextTraceId = traceId
      try {
        return tracer.startSpan(name, { kind, startTime: startTimeMs, attributes, root: true })
      } finally {
        this.idGenerator.nextTraceId = null
      }
    }

    const metricReader =
      config.metricReader ??
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${base}/v1/metrics`,
          headers,
          temporalityPreference: AggregationTemporality.DELTA,
        }),
      })
    this.meterProvider = new MeterProvider({ resource, readers: [metricReader] })
    const meter = this.meterProvider.getMeter(SCOPE_NAME)
    this.tokenCounter = meter.createCounter(METRIC.tokenUsage, { unit: TOKEN_UNIT })
    this.durationHistogram = meter.createHistogram(METRIC.duration, { unit: DURATION_UNIT })
  }

  recordGeneration(event: LlmGenerationEvent): void {
    try {
      const mapped = mapGeneration(event)
      this.emitSpan(mapped, SpanKind.CLIENT)
      const metrics = mapGenerationMetrics(event)
      for (const point of metrics.tokenUsage) {
        this.tokenCounter.add(point.value, point.attributes as Attributes)
      }
      this.durationHistogram.record(
        metrics.durationSeconds,
        metrics.durationAttributes as Attributes,
      )
    } catch (err) {
      this.warn(err)
    }
  }

  recordToolSpans(context: LlmToolSpanContext, spans: LlmToolSpan[]): void {
    if (!context.executionId || spans.length === 0) return
    try {
      for (const span of spans) {
        this.emitSpan(mapToolSpan(context, span), SpanKind.INTERNAL)
      }
    } catch (err) {
      this.warn(err)
    }
  }

  private emitSpan(mapped: MappedSpan, kind: SpanKind): void {
    const span = this.startSpanForRun(
      mapped.name,
      mapped.traceId,
      mapped.startTimeMs,
      kind,
      mapped.attributes as Attributes,
    )
    for (const event of mapped.events) {
      span.addEvent(event.name, event.attributes as Attributes, event.timeMs)
    }
    if (!mapped.ok) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: mapped.statusMessage })
    }
    span.end(mapped.endTimeMs)
  }

  /** Flush any buffered spans/metrics (e.g. before shutdown). Best-effort. */
  async forceFlush(): Promise<void> {
    try {
      await Promise.all([this.tracerProvider.forceFlush(), this.meterProvider.forceFlush()])
    } catch (err) {
      this.warn(err)
    }
  }

  /** Shut the providers down, flushing first. Wire into the facade's stop path. */
  async shutdown(): Promise<void> {
    try {
      await Promise.all([this.tracerProvider.shutdown(), this.meterProvider.shutdown()])
    } catch (err) {
      this.warn(err)
    }
  }

  private warn(err: unknown): void {
    this.logger?.warn(
      { scope: 'otel', err: err instanceof Error ? err.message : String(err) },
      'otel: failed to record telemetry',
    )
  }
}

/** Build an SDK-backed {@link NodeOtelTraceSink}. The Node/local facades' OTLP exporter. */
export function createNodeOtelSink(config: NodeOtelSinkConfig): NodeOtelTraceSink {
  return new NodeOtelTraceSink(config)
}
