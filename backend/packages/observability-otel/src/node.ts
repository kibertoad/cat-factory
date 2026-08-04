import {
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Span,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
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
  randomSpanId,
  randomTraceId,
} from './mapping.js'

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
  logger?: Logger
  /** Test seam: override the span processor (e.g. a SimpleSpanProcessor over an in-memory exporter). */
  spanProcessor?: SpanProcessor
  /** Test seam: override the metric reader (e.g. one over an InMemoryMetricExporter). */
  metricReader?: MetricReader
}

/**
 * Forces the ids of the next span so this transport emits exactly what the mapping layer
 * decided. The SDK calls both generators synchronously inside `startSpan`, so we set the
 * pending values immediately before the call and clear them after.
 *
 * The trace id matters for a ROOT span (a child inherits its parent's). The SPAN id matters
 * for every parent in the hierarchy: the run and step spans carry ids DERIVED from the run,
 * which is the whole reason a generation emitted hours earlier could name one — an
 * SDK-minted random id would leave every child pointing at a parent that never exists.
 */
class RunIdGenerator implements IdGenerator {
  nextTraceId: string | null = null
  nextSpanId: string | null = null

  generateTraceId(): string {
    return this.nextTraceId ?? randomTraceId()
  }

  generateSpanId(): string {
    return this.nextSpanId ?? randomSpanId()
  }
}

/** The neutral span kind the mapping layer decided, in the SDK's own enum. */
const SDK_SPAN_KIND: Record<MappedSpan['kind'], SpanKind> = {
  internal: SpanKind.INTERNAL,
  client: SpanKind.CLIENT,
}

/**
 * A context naming an already-emitted (or yet-to-be-emitted) span as the parent, built from
 * ids alone. The SDK normally takes a parent from an ACTIVE span, which a stateless per-call
 * emission never has — this is the supported way to attach to a parent the process never held.
 * Marked SAMPLED so the child isn't dropped for inheriting an unsampled parent.
 */
function parentContextOf(traceId: string, parentSpanId: string): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: parentSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  })
}

export class NodeOtelTraceSink implements LlmTraceSink {
  private readonly tracerProvider: NodeTracerProvider
  private readonly meterProvider: MeterProvider
  private readonly idGenerator: RunIdGenerator
  private readonly logger?: Logger
  private readonly startMappedSpan: (mapped: MappedSpan) => Span
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
    this.startMappedSpan = (mapped) => {
      this.idGenerator.nextTraceId = mapped.traceId
      this.idGenerator.nextSpanId = mapped.spanId
      try {
        const options = {
          kind: SDK_SPAN_KIND[mapped.kind],
          startTime: mapped.startTimeMs,
          attributes: mapped.attributes as Attributes,
        }
        // With a parent context the SDK takes the trace id from the parent; `root: true` is
        // for the spans that genuinely have none (a run root, a standalone inline call).
        return mapped.parentSpanId
          ? tracer.startSpan(
              mapped.name,
              options,
              parentContextOf(mapped.traceId, mapped.parentSpanId),
            )
          : tracer.startSpan(mapped.name, { ...options, root: true })
      } finally {
        this.idGenerator.nextTraceId = null
        this.idGenerator.nextSpanId = null
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
      this.emitSpan(mapGeneration(event))
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
        this.emitSpan(mapToolSpan(context, span))
      }
    } catch (err) {
      this.warn(err)
    }
  }

  /** The settled run's root + step spans: the parents everything else already named. */
  recordRunSpans(run: LlmRunSpan, steps: LlmStepSpan[]): void {
    try {
      this.emitSpan(mapRunSpan(run))
      for (const step of steps) this.emitSpan(mapStepSpan(step))
    } catch (err) {
      this.warn(err)
    }
  }

  private emitSpan(mapped: MappedSpan): void {
    const span = this.startMappedSpan(mapped)
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
    this.logger?.warn('otel: failed to record telemetry', {
      scope: 'otel',
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Build an SDK-backed {@link NodeOtelTraceSink}. The Node/local facades' OTLP exporter. */
export function createNodeOtelSink(config: NodeOtelSinkConfig): NodeOtelTraceSink {
  return new NodeOtelTraceSink(config)
}
