import { describe, expect, it, vi } from 'vitest'
import type { LlmGenerationEvent } from '@cat-factory/kernel'
import { OtelTraceSink } from './index.js'

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

function firstSpan(body: Record<string, unknown>): Record<string, unknown> {
  const rs = (body.resourceSpans as Record<string, unknown>[])[0]!
  const ss = (rs.scopeSpans as Record<string, unknown>[])[0]!
  return (ss.spans as Record<string, unknown>[])[0]!
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
    expect(span.name).toBe('coder')
    expect((span.traceId as string).length).toBe(32)
    expect((span.spanId as string).length).toBe(16)
    expect(span.startTimeUnixNano).toBe('1000000000')
    expect(span.endTimeUnixNano).toBe('1500000000')
    const spanAttrs = attrMap(span.attributes as KeyValue[])
    expect(spanAttrs['gen_ai.system']).toBe('openai')
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
    expect(byType).toEqual({ input: 100, output: 40 })
    const durationMetric = ms.find((m) => m.name === 'gen_ai.client.operation.duration')!
    expect(durationMetric.unit).toBe('s')
    const hist = durationMetric.histogram as { dataPoints: Record<string, unknown>[] }
    expect(hist.dataPoints[0]!.sum).toBe(0.5)
    expect(hist.dataPoints[0]!.count).toBe('1')
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
  })

  it('groups a run under one deterministic trace id across calls', async () => {
    const { fetchImpl, calls } = capturingFetch()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, fetchImpl })

    await sink.recordGeneration(baseEvent({ agentKind: 'architect' }))
    await sink.recordGeneration(baseEvent({ agentKind: 'coder' }))

    const [first, second] = tracesOf(calls)
    expect(firstSpan(first!.body).traceId).toBe(firstSpan(second!.body).traceId)
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
    const spans = (
      (traceCalls[0]!.body.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<
        string,
        unknown
      >[]
    )[0]!.spans as Record<string, unknown>[]
    expect(spans.map((s) => s.name)).toEqual(['edit_file', 'run_command'])
    expect((spans[1]!.status as { code: number }).code).toBe(2) // ERROR
  })

  it('never throws when the OTLP endpoint fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    const warn = vi.fn()
    const sink = new OtelTraceSink({ endpoint: COLLECTOR, logger: { warn }, fetchImpl })

    await expect(sink.recordGeneration(baseEvent())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
