import { describe, expect, it } from 'vitest'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import type { LlmGenerationEvent, LlmToolSpan, LlmToolSpanContext } from '@cat-factory/kernel'
import { OtelTraceSink } from './index.js'
import { NodeOtelTraceSink } from './node.js'

// The guard the CF↔Node transport split requires: the workerd-safe fetch exporter and the
// official-SDK exporter go through the SAME `./mapping` layer, so feeding both the SAME
// events must yield semantically equivalent OpenTelemetry telemetry. This drives both over
// an identical script and asserts the normalised telemetry matches — service name, span
// names + attributes + status + trace-id grouping, and metric names/units/values. It
// compares the *semantic content*, not the JSON-vs-in-memory wire representation. If either
// transport drifts (a renamed attribute, a lost dimension, a different trace grouping),
// this fails.

const COLLECTOR = 'http://collector.test:4318'

const GENERATION: LlmGenerationEvent = {
  workspaceId: 'ws1',
  executionId: 'exec-42',
  agentKind: 'coder',
  provider: 'anthropic',
  model: 'claude-x',
  startedAt: 2_000,
  endedAt: 2_750,
  promptTokens: 321,
  completionTokens: 87,
  totalTokens: 408,
  finishReason: 'stop',
  ok: true,
  errorMessage: null,
  input: '[{"role":"user","content":"go"}]',
  output: 'done',
}
const TOOL_CONTEXT: LlmToolSpanContext = {
  workspaceId: 'ws1',
  executionId: 'exec-42',
  agentKind: 'coder',
}
const TOOL_SPANS: LlmToolSpan[] = [
  { tool: 'edit_file', startedAt: 2_100, endedAt: 2_200, ok: true },
  { tool: 'run_command', startedAt: 2_300, endedAt: 2_400, ok: false },
]

/** The normalised, transport-independent projection the two exporters must agree on. */
interface NormalizedTelemetry {
  serviceName: string
  spans: {
    name: string
    traceId: string
    attributes: Record<string, unknown>
    statusCode: number
    events: string[]
  }[]
  tokenUsage: Record<string, number>
  duration: { count: number; sum: number }
}

// ---- fetch exporter (OTLP/JSON over intercepted fetch) --------------------

interface KV {
  key: string
  value: Record<string, unknown>
}
function attrs(kvs: KV[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const kv of kvs) {
    const v = kv.value
    out[kv.key] =
      'stringValue' in v
        ? v.stringValue
        : 'intValue' in v
          ? Number(v.intValue)
          : 'doubleValue' in v
            ? v.doubleValue
            : 'arrayValue' in v
              ? (v.arrayValue as { values: Record<string, unknown>[] }).values.map(
                  (x) => x.stringValue,
                )
              : undefined
  }
  return out
}

// OTLP status: UNSET(0)/ERROR(2). The SDK maps the same, so normalise both to those codes.
async function collectFetch(): Promise<NormalizedTelemetry> {
  const traceBodies: Record<string, unknown>[] = []
  const metricBodies: Record<string, unknown>[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (String(url).endsWith('/v1/traces')) traceBodies.push(body)
    else if (String(url).endsWith('/v1/metrics')) metricBodies.push(body)
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch

  {
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, serviceName: 'cat-factory', fetchImpl })
    await sink.recordGeneration(GENERATION)
    await sink.recordToolSpans(TOOL_CONTEXT, TOOL_SPANS)

    const spans: NormalizedTelemetry['spans'] = []
    let serviceName = ''
    for (const body of traceBodies) {
      for (const rs of body.resourceSpans as Record<string, unknown>[]) {
        serviceName = String(
          attrs((rs.resource as { attributes: KV[] }).attributes)['service.name'],
        )
        for (const ss of rs.scopeSpans as Record<string, unknown>[]) {
          for (const s of ss.spans as Record<string, unknown>[]) {
            spans.push({
              name: String(s.name),
              traceId: String(s.traceId),
              attributes: attrs(s.attributes as KV[]),
              statusCode: (s.status as { code: number }).code,
              events: (s.events as Record<string, unknown>[]).map((e) => String(e.name)),
            })
          }
        }
      }
    }

    const tokenUsage: Record<string, number> = {}
    const duration = { count: 0, sum: 0 }
    for (const body of metricBodies) {
      for (const rm of body.resourceMetrics as Record<string, unknown>[]) {
        for (const sm of rm.scopeMetrics as Record<string, unknown>[]) {
          for (const m of sm.metrics as Record<string, unknown>[]) {
            if (m.name === 'gen_ai.client.token.usage') {
              for (const p of (m.sum as { dataPoints: Record<string, unknown>[] }).dataPoints) {
                tokenUsage[String(attrs(p.attributes as KV[])['gen_ai.token.type'])] = Number(
                  p.asInt,
                )
              }
            } else if (m.name === 'gen_ai.client.operation.duration') {
              const p = (m.histogram as { dataPoints: Record<string, unknown>[] }).dataPoints[0]!
              duration.count += Number(p.count)
              duration.sum += Number(p.sum)
            }
          }
        }
      }
    }
    return { serviceName, spans, tokenUsage, duration }
  }
}

// ---- SDK exporter (official @opentelemetry/* via in-memory readers) -------

async function collectSdk(): Promise<NormalizedTelemetry> {
  const spanExporter = new InMemorySpanExporter()
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
  const sink = new NodeOtelTraceSink({
    endpoint: 'http://unused.test:4318',
    serviceName: 'cat-factory',
    spanProcessor: new SimpleSpanProcessor(spanExporter),
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 3_600_000,
    }),
  })
  sink.recordGeneration(GENERATION)
  sink.recordToolSpans(TOOL_CONTEXT, TOOL_SPANS)
  await sink.forceFlush()

  const finished = spanExporter.getFinishedSpans()
  const serviceName = String(finished[0]?.resource.attributes['service.name'] ?? '')
  const spans: NormalizedTelemetry['spans'] = finished.map((s) => ({
    name: s.name,
    traceId: s.spanContext().traceId,
    attributes: { ...s.attributes },
    // ReadableSpan status uses the same numeric codes as OTLP (UNSET=0, ERROR=2).
    statusCode: s.status.code,
    events: s.events.map((e) => e.name),
  }))

  const tokenUsage: Record<string, number> = {}
  const duration = { count: 0, sum: 0 }
  for (const batch of metricExporter.getMetrics()) {
    for (const sm of batch.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === 'gen_ai.client.token.usage') {
          for (const p of m.dataPoints) {
            tokenUsage[String((p.attributes as Record<string, unknown>)['gen_ai.token.type'])] =
              p.value as number
          }
        } else if (m.descriptor.name === 'gen_ai.client.operation.duration') {
          const hist = m.dataPoints[0]!.value as { count: number; sum?: number }
          duration.count += hist.count
          duration.sum += hist.sum ?? 0
        }
      }
    }
  }
  await sink.shutdown()
  return { serviceName, spans, tokenUsage, duration }
}

describe('OTLP transport conformity: fetch exporter ↔ SDK exporter', () => {
  it('emit semantically equivalent telemetry for the same events', async () => {
    const fetchTel = await collectFetch()
    const sdkTel = await collectSdk()

    // Same resource identity.
    expect(fetchTel.serviceName).toBe('cat-factory')
    expect(sdkTel.serviceName).toBe('cat-factory')

    // Same metrics.
    expect(fetchTel.tokenUsage).toEqual({ input: 321, output: 87 })
    expect(sdkTel.tokenUsage).toEqual(fetchTel.tokenUsage)
    expect(fetchTel.duration.count).toBe(sdkTel.duration.count)
    expect(fetchTel.duration.sum).toBeCloseTo(sdkTel.duration.sum, 9)

    // Same spans (name, attributes, status, events) keyed by name — span ids differ (random),
    // trace ids must MATCH (deterministic per-run derivation shared via ./mapping).
    const byName = (t: NormalizedTelemetry) => new Map(t.spans.map((s) => [s.name, s]))
    const fetchSpans = byName(fetchTel)
    const sdkSpans = byName(sdkTel)
    expect([...fetchSpans.keys()].sort()).toEqual([...sdkSpans.keys()].sort())
    expect([...fetchSpans.keys()].sort()).toEqual(['coder', 'edit_file', 'run_command'])

    for (const [name, fetchSpan] of fetchSpans) {
      const sdkSpan = sdkSpans.get(name)!
      expect(sdkSpan.attributes, name).toEqual(fetchSpan.attributes)
      expect(sdkSpan.statusCode, name).toBe(fetchSpan.statusCode)
      expect(sdkSpan.events, name).toEqual(fetchSpan.events)
      expect(sdkSpan.traceId, name).toBe(fetchSpan.traceId)
    }

    // A run's generation + its tool spans share one trace id, in BOTH transports.
    const traceIds = new Set([...fetchSpans.values()].map((s) => s.traceId))
    expect(traceIds.size).toBe(1)
    expect(new Set([...sdkSpans.values()].map((s) => s.traceId))).toEqual(traceIds)
  })
})
