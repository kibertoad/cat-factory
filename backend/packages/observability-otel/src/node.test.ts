import { describe, expect, it } from 'vitest'
import { SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import type { LlmGenerationEvent } from '@cat-factory/kernel'
import { NodeOtelTraceSink } from './node.js'

function baseEvent(overrides: Partial<LlmGenerationEvent> = {}): LlmGenerationEvent {
  return {
    workspaceId: 'ws1',
    executionId: 'exec1',
    agentKind: 'coder',
    provider: 'openai',
    model: 'gpt-4o-mini',
    startedAt: 1_000,
    endedAt: 1_500,
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    finishReason: 'stop',
    ok: true,
    errorMessage: null,
    input: '[{"role":"user","content":"hi"}]',
    output: 'hello',
    ...overrides,
  }
}

/** Build an SDK sink wired to in-memory exporters so emitted telemetry can be read back. */
function harness() {
  const spans = new InMemorySpanExporter()
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000, // never auto-exports; we force-flush explicitly
  })
  const sink = new NodeOtelTraceSink({
    endpoint: 'http://unused.test:4318',
    serviceName: 'cat-factory-test',
    spanProcessor: new SimpleSpanProcessor(spans),
    metricReader,
  })
  return { sink, spans, metricExporter }
}

describe('NodeOtelTraceSink (official SDK exporter)', () => {
  it('records a generation span with the GenAI attributes and events', async () => {
    const { sink, spans } = harness()
    sink.recordGeneration(baseEvent())

    const [span] = spans.getFinishedSpans()
    expect(span).toBeDefined()
    expect(span!.name).toBe('coder')
    expect(span!.attributes['gen_ai.system']).toBe('openai')
    expect(span!.attributes['gen_ai.request.model']).toBe('gpt-4o-mini')
    expect(span!.attributes['gen_ai.usage.input_tokens']).toBe(100)
    expect(span!.attributes['gen_ai.usage.output_tokens']).toBe(40)
    expect(span!.attributes['gen_ai.response.finish_reasons']).toEqual(['stop'])
    expect(span!.attributes['cat_factory.agent_kind']).toBe('coder')
    expect(span!.status.code).toBe(SpanStatusCode.UNSET)
    expect(span!.events.map((e) => e.name)).toEqual([
      'gen_ai.content.prompt',
      'gen_ai.content.completion',
    ])
    await sink.shutdown()
  })

  it('groups a run under one trace id across calls', async () => {
    const { sink, spans } = harness()
    sink.recordGeneration(baseEvent({ agentKind: 'architect' }))
    sink.recordGeneration(baseEvent({ agentKind: 'coder' }))

    const finished = spans.getFinishedSpans()
    expect(finished).toHaveLength(2)
    expect(finished[0]!.spanContext().traceId).toBe(finished[1]!.spanContext().traceId)
    await sink.shutdown()
  })

  it('marks a failed call as ERROR with a message', async () => {
    const { sink, spans } = harness()
    sink.recordGeneration(baseEvent({ ok: false, errorMessage: 'boom', finishReason: null }))

    const [span] = spans.getFinishedSpans()
    expect(span!.status.code).toBe(SpanStatusCode.ERROR)
    expect(span!.status.message).toBe('boom')
    await sink.shutdown()
  })

  it('records token-usage and duration metrics', async () => {
    const { sink, metricExporter } = harness()
    sink.recordGeneration(baseEvent())
    await sink.forceFlush()

    const batches = metricExporter.getMetrics()
    const metrics = batches.flatMap((b) => b.scopeMetrics.flatMap((s) => s.metrics))
    const token = metrics.find((m) => m.descriptor.name === 'gen_ai.client.token.usage')!
    expect(token.descriptor.unit).toBe('{token}')
    const byType = Object.fromEntries(
      token.dataPoints.map((p) => [
        (p.attributes as Record<string, unknown>)['gen_ai.token.type'],
        p.value,
      ]),
    )
    expect(byType).toEqual({ input: 100, output: 40 })

    const duration = metrics.find((m) => m.descriptor.name === 'gen_ai.client.operation.duration')!
    expect(duration.descriptor.unit).toBe('s')
    const point = duration.dataPoints[0]!.value as { count: number; sum?: number }
    expect(point.count).toBe(1)
    expect(point.sum).toBe(0.5)
    await sink.shutdown()
  })

  it('emits one internal span per tool span, skipping when there is no run', async () => {
    const { sink, spans } = harness()
    sink.recordToolSpans({ workspaceId: 'ws1', executionId: 'exec1', agentKind: 'coder' }, [
      { tool: 'edit_file', startedAt: 1, endedAt: 2, ok: true },
      { tool: 'run_command', startedAt: 3, endedAt: 4, ok: false },
    ])
    sink.recordToolSpans({ workspaceId: 'ws1', executionId: null, agentKind: 'coder' }, [
      { tool: 'x', startedAt: 1, endedAt: 2, ok: true },
    ])

    const finished = spans.getFinishedSpans()
    expect(finished.map((s) => s.name)).toEqual(['edit_file', 'run_command'])
    expect(finished[1]!.status.code).toBe(SpanStatusCode.ERROR)
    await sink.shutdown()
  })

  it('never throws into the caller', () => {
    const { sink } = harness()
    // A malformed event must not surface — the sink swallows + logs.
    expect(() => sink.recordGeneration(baseEvent())).not.toThrow()
  })
})
