import { describe, expect, it } from 'vitest'
import {
  createRecordingLogger,
  type LlmGenerationEvent,
  type LlmRunSpan,
  type LlmStepSpan,
} from '@cat-factory/kernel'
import { OtelTraceSink } from './index.js'
import { deriveRunSpanId, deriveStepSpanId } from './mapping.js'

// The fetch exporter POSTs OTLP/JSON to the collector over its injectable `fetchImpl`
// (defaulting to the global `fetch`). We inject a capturing stub rather than intercept the
// global dispatcher, so the assertions are deterministic and independent of the undici
// version backing the environment's `fetch`.
const COLLECTOR = 'http://collector.test:4318'

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function capturingFetch(): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const tracesOf = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/v1/traces'))
const metricsOf = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/v1/metrics'))

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
    cacheReadTokens: 900,
    cacheWriteTokens: 40,
    completionTokens: 40,
    // 100 fresh + 900 cache read + 40 cache write + 40 output: the classes are orthogonal,
    // so a fixture keeping the pre-split 140 would describe a call that cannot exist.
    totalTokens: 1_080,
    finishReason: 'stop',
    ok: true,
    errorMessage: null,
    input: '[{"role":"user","content":"hi"}]',
    output: 'hello',
    ...overrides,
  }
}

interface KeyValue {
  key: string
  value: Record<string, unknown>
}
function attrMap(kvs: KeyValue[]): Record<string, unknown> {
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

function spansOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const rs = (body.resourceSpans as Record<string, unknown>[])[0]!
  const ss = (rs.scopeSpans as Record<string, unknown>[])[0]!
  return ss.spans as Record<string, unknown>[]
}
function firstSpan(body: Record<string, unknown>): Record<string, unknown> {
  return spansOf(body)[0]!
}
function resourceServiceName(body: Record<string, unknown>): unknown {
  const rs = (body.resourceSpans as Record<string, unknown>[])[0]!
  return attrMap((rs.resource as { attributes: KeyValue[] }).attributes)['service.name']
}

describe('OtelTraceSink (fetch OTLP exporter)', () => {
  it('posts a generation span to /v1/traces and metrics to /v1/metrics', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({
      endpoint: `${COLLECTOR}/`,
      headers: { 'x-api-key': 'secret' },
      serviceName: 'cat-factory-test',
      fetchImpl,
    })

    await sink.recordGeneration(baseEvent())

    const [traceCall] = tracesOf(calls)
    expect(traceCall).toBeDefined()
    // Trailing slash on the endpoint is normalised — the path is exactly `/v1/traces`.
    expect(traceCall!.url).toBe(`${COLLECTOR}/v1/traces`)
    expect(traceCall!.headers['x-api-key']).toBe('secret')
    expect(traceCall!.headers['content-type']).toContain('application/json')

    expect(resourceServiceName(traceCall!.body)).toBe('cat-factory-test')
    const span = firstSpan(traceCall!.body)
    // The convention's `{operation} {request model}` span name; the agent kind names the STEP
    // span one level up and still rides here as an attribute.
    expect(span.name).toBe('chat gpt-4o-mini')
    expect((span.traceId as string).length).toBe(32)
    expect((span.spanId as string).length).toBe(16)
    // Parented onto its agent kind's step span, derived from the run — not a sibling.
    expect(span.parentSpanId).toBe(deriveStepSpanId('exec1', 'coder'))
    expect(span.startTimeUnixNano).toBe('1000000000')
    expect(span.endTimeUnixNano).toBe('1500000000')
    const spanAttrs = attrMap(span.attributes as KeyValue[])
    expect(spanAttrs['gen_ai.system']).toBe('openai')
    expect(spanAttrs['gen_ai.operation.name']).toBe('chat')
    expect(spanAttrs['gen_ai.request.model']).toBe('gpt-4o-mini')
    expect(spanAttrs['gen_ai.usage.input_tokens']).toBe(100)
    expect(spanAttrs['gen_ai.usage.output_tokens']).toBe(40)
    expect(spanAttrs['gen_ai.response.finish_reasons']).toEqual(['stop'])
    expect(spanAttrs['cat_factory.workspace_id']).toBe('ws1')
    expect(spanAttrs['cat_factory.agent_kind']).toBe('coder')
    expect((span.status as { code: number }).code).toBe(0) // UNSET
    const events = span.events as Record<string, unknown>[]
    expect(events.map((e) => e.name)).toEqual([
      'gen_ai.content.prompt',
      'gen_ai.content.completion',
    ])

    const [metricCall] = metricsOf(calls)
    expect(metricCall!.url).toBe(`${COLLECTOR}/v1/metrics`)
    const ms = (
      (metricCall!.body.resourceMetrics as Record<string, unknown>[])[0]!.scopeMetrics as Record<
        string,
        unknown
      >[]
    )[0]!.metrics as Record<string, unknown>[]
    const tokenMetric = ms.find((m) => m.name === 'gen_ai.client.token.usage')!
    expect(tokenMetric.unit).toBe('{token}')
    const sum = tokenMetric.sum as {
      aggregationTemporality: number
      dataPoints: Record<string, unknown>[]
    }
    expect(sum.aggregationTemporality).toBe(1) // DELTA
    const byType = Object.fromEntries(
      sum.dataPoints.map((p) => [
        attrMap(p.attributes as KeyValue[])['gen_ai.token.type'],
        Number(p.asInt),
      ]),
    )
    // One data point per input CLASS (fresh / cache read / cache write) plus output.
    expect(byType).toEqual({ input: 100, cache_read: 900, cache_write: 40, output: 40 })
    // The workspace id is on the SPAN (high cardinality is fine there)…
    expect(spanAttrs['cat_factory.workspace_id']).toBe('ws1')
    // …but MUST NOT be on the metric data points: workspace id is unbounded, so carrying it
    // on a metric would explode the backend's time-series cardinality. Only the bounded
    // provider/model/agent-kind dimensions ride the metrics.
    const tokenPointAttrs = attrMap(sum.dataPoints[0]!.attributes as KeyValue[])
    expect(tokenPointAttrs['cat_factory.workspace_id']).toBeUndefined()
    expect(tokenPointAttrs['gen_ai.system']).toBe('openai')
    const durationMetric = ms.find((m) => m.name === 'gen_ai.client.operation.duration')!
    expect(durationMetric.unit).toBe('s')
    const hist = durationMetric.histogram as { dataPoints: Record<string, unknown>[] }
    expect(hist.dataPoints[0]!.sum).toBe(0.5)
    expect(hist.dataPoints[0]!.count).toBe('1')
    expect(
      attrMap(hist.dataPoints[0]!.attributes as KeyValue[])['cat_factory.workspace_id'],
    ).toBeUndefined()
  })

  it('omits prompt/completion events when bodies are empty (LLM_RECORD_PROMPTS=false)', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, fetchImpl })

    await sink.recordGeneration(baseEvent({ input: '', output: '' }))

    const span = firstSpan(tracesOf(calls)[0]!.body)
    expect(span.events).toEqual([])
    expect(attrMap(span.attributes as KeyValue[])['gen_ai.usage.input_tokens']).toBe(100)
  })

  it('marks failed calls ERROR with a message and a standalone trace when no run', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, fetchImpl })

    await sink.recordGeneration(
      baseEvent({ executionId: null, ok: false, errorMessage: 'boom', finishReason: null }),
    )

    const span = firstSpan(tracesOf(calls)[0]!.body)
    expect((span.status as { code: number; message: string }).code).toBe(2) // ERROR
    expect((span.status as { message: string }).message).toBe('boom')
    expect((span.traceId as string).length).toBe(32)
    // No run ⇒ no step span to hang under, so the call stays a ROOT rather than pointing at a
    // parent that will never be emitted.
    expect(span.parentSpanId).toBeUndefined()
  })

  it('groups a run under one deterministic trace id across calls', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, fetchImpl })

    await sink.recordGeneration(baseEvent({ agentKind: 'architect' }))
    await sink.recordGeneration(baseEvent({ agentKind: 'coder' }))

    const [first, second] = tracesOf(calls)
    expect(firstSpan(first!.body).traceId).toBe(firstSpan(second!.body).traceId)
  })

  it('carries a tool call\'s arguments and result as span events, with its ordinal', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, fetchImpl })

    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: 'exec1', agentKind: 'coder' }, [
      {
        tool: 'run_command',
        seq: 3,
        startedAt: 1,
        endedAt: 2,
        ok: true,
        bodies: 'stored',
        args: '{"command":"pnpm build"}',
        result: 'built in 4s',
        argsDropped: 0,
        resultDropped: 900,
      },
      // Withheld by the body gate: the metadata still exports, the bodies do not, and the span
      // carries no empty event that would read as a call which took no arguments.
      {
        tool: 'read',
        seq: 4,
        startedAt: 3,
        endedAt: 4,
        ok: true,
        bodies: 'withheld',
        args: '',
        result: '',
        argsDropped: 0,
        resultDropped: 0,
      },
    ])

    const spans = spansOf(tracesOf(calls)[0]!.body)
    const events = (spans[0]!.events ?? []) as { name: string; attributes?: unknown[] }[]
    expect(events.map((e) => e.name)).toEqual(['gen_ai.tool.arguments', 'gen_ai.tool.result'])
    const attrs = attrMap(spans[0]!.attributes as KeyValue[])
    expect(attrs['cat_factory.tool_call.seq']).toBe(3)
    // What the cap dropped is stated, so a truncated result is legible AS truncated.
    expect(attrs['cat_factory.tool_call.result_dropped_chars']).toBe(900)
    expect(spans[1]!.events ?? []).toEqual([])
  })

  it('emits one internal span per tool span, skipping when there is no run', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, fetchImpl })

    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: 'exec1', agentKind: 'coder' }, [
      { tool: 'edit_file', startedAt: 1, endedAt: 2, ok: true },
      { tool: 'run_command', startedAt: 3, endedAt: 4, ok: false },
    ])
    // No execution id ⇒ nothing sent.
    await sink.recordToolSpans({ workspaceId: 'ws1', executionId: null, agentKind: 'coder' }, [
      { tool: 'x', startedAt: 1, endedAt: 2, ok: true },
    ])

    const traceCalls = tracesOf(calls)
    expect(traceCalls).toHaveLength(1)
    const spans = spansOf(traceCalls[0]!.body)
    expect(spans.map((s) => s.name)).toEqual(['execute_tool edit_file', 'execute_tool run_command'])
    expect((spans[1]!.status as { code: number }).code).toBe(2) // ERROR
    // Tool calls hang under the SAME step span the agent kind's generations do, so a step's
    // model calls and its tool calls interleave in one waterfall.
    for (const span of spans) {
      expect(span.parentSpanId).toBe(deriveStepSpanId('exec1', 'coder'))
      expect(attrMap(span.attributes as KeyValue[])['gen_ai.operation.name']).toBe('execute_tool')
    }
  })

  it('emits the settled run root + step spans the children already named as parents', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, fetchImpl })

    // A generation exports FIRST, hours before the run settles — the ordinary OTel ordering.
    await sink.recordGeneration(baseEvent())

    const run: LlmRunSpan = {
      workspaceId: 'ws1',
      executionId: 'exec1',
      pipelineName: 'Bugfix',
      startedAt: 500,
      endedAt: 9_000,
      ok: false,
      errorMessage: 'ci_failed',
    }
    const steps: LlmStepSpan[] = [
      {
        workspaceId: 'ws1',
        executionId: 'exec1',
        agentKind: 'coder',
        startedAt: 900,
        endedAt: 4_000,
        stepCount: 2,
        attemptCount: 3,
        ok: true,
        errorMessage: null,
      },
    ]
    await sink.recordRunSpans(run, steps)

    // ONE POST: a step span whose root landed in a separately-failing request would leave the
    // trace as broken as no parents at all.
    const runCall = tracesOf(calls).at(-1)!
    const spans = spansOf(runCall.body)
    expect(spans).toHaveLength(2)

    const [rootSpan, stepSpan] = spans as [Record<string, unknown>, Record<string, unknown>]
    // The bare operation, with the workspace-authored pipeline kept to an attribute: a span
    // name is the low-cardinality class a backend derives RED metrics from.
    expect(rootSpan.name).toBe('run')
    expect(attrMap(rootSpan.attributes as KeyValue[])['cat_factory.pipeline']).toBe('Bugfix')
    expect(rootSpan.spanId).toBe(deriveRunSpanId('exec1'))
    expect(rootSpan.parentSpanId).toBeUndefined()
    expect((rootSpan.status as { code: number; message: string }).code).toBe(2) // ERROR
    expect((rootSpan.status as { message: string }).message).toBe('ci_failed')
    // A run is orchestration, not a model call: no GenAI operation is claimed for it.
    expect(attrMap(rootSpan.attributes as KeyValue[])['gen_ai.operation.name']).toBeUndefined()

    expect(stepSpan.name).toBe('invoke_agent coder')
    expect(stepSpan.spanId).toBe(deriveStepSpanId('exec1', 'coder'))
    expect(stepSpan.parentSpanId).toBe(rootSpan.spanId)
    const stepAttrs = attrMap(stepSpan.attributes as KeyValue[])
    expect(stepAttrs['gen_ai.operation.name']).toBe('invoke_agent')
    expect(stepAttrs['gen_ai.agent.name']).toBe('coder')
    // Both folds are STATED, so a two-step slice isn't read as one long step and a three-round
    // loop isn't read as one long round.
    expect(stepAttrs['cat_factory.step_count']).toBe(2)
    expect(stepAttrs['cat_factory.attempt_count']).toBe(3)

    // The whole hierarchy is one trace, and the generation emitted earlier already pointed at
    // the step span this request finally supplies.
    const generationSpan = firstSpan(tracesOf(calls)[0]!.body)
    expect(generationSpan.parentSpanId).toBe(stepSpan.spanId)
    expect(generationSpan.traceId).toBe(rootSpan.traceId)
    expect(stepSpan.traceId).toBe(rootSpan.traceId)
  })

  it('never throws when the OTLP endpoint fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    const logger = createRecordingLogger()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, logger, fetchImpl })

    await expect(sink.recordGeneration(baseEvent())).resolves.toBeUndefined()
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })
})
