import { describe, expect, it, vi } from 'vitest'
import type {
  LlmGenerationEvent,
  LlmRunSpan,
  LlmStepSpan,
  LlmToolSpan,
  LlmToolSpanContext,
  LlmTraceSink,
} from './llm-trace-sink.js'
import { CompositeTraceSink, composeTraceSinks } from './llm-trace-sink.js'
import { createRecordingLogger } from './logging.js'
import { createOperationalMetricsCollector } from './operational-metrics.js'

// Focused coverage for the fan-out + 0/1/many collapse used by every facade to compose
// multiple external trace destinations (Langfuse + OTLP) into the single sink slot.

const EVENT: LlmGenerationEvent = {
  workspaceId: 'ws1',
  executionId: 'exec1',
  agentKind: 'coder',
  provider: 'openai',
  model: 'm',
  startedAt: 1,
  endedAt: 2,
  promptTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 1,
  totalTokens: 2,
  finishReason: 'stop',
  ok: true,
  errorMessage: null,
  input: '',
  output: '',
}
const CTX: LlmToolSpanContext = { workspaceId: 'ws1', executionId: 'exec1', agentKind: 'coder' }
const SPANS: LlmToolSpan[] = [{ tool: 't', startedAt: 1, endedAt: 2, ok: true }]
const RUN: LlmRunSpan = {
  workspaceId: 'ws1',
  executionId: 'exec1',
  pipelineName: 'Bugfix',
  startedAt: 1,
  endedAt: 9,
  ok: true,
  errorMessage: null,
}
const STEPS: LlmStepSpan[] = [
  {
    workspaceId: 'ws1',
    executionId: 'exec1',
    agentKind: 'coder',
    startedAt: 1,
    endedAt: 5,
    stepCount: 1,
    attemptCount: 1,
    ok: true,
    errorMessage: null,
  },
]

function fakeSink(): LlmTraceSink & {
  gen: ReturnType<typeof vi.fn>
  tools: ReturnType<typeof vi.fn>
  runSpans: ReturnType<typeof vi.fn>
} {
  const gen = vi.fn()
  const tools = vi.fn()
  const runSpans = vi.fn()
  return {
    recordGeneration: gen,
    recordToolSpans: tools,
    recordRunSpans: runSpans,
    gen,
    tools,
    runSpans,
  }
}

describe('composeTraceSinks', () => {
  it('returns undefined for no sinks', () => {
    expect(composeTraceSinks([])).toBeUndefined()
    expect(composeTraceSinks([undefined, undefined])).toBeUndefined()
  })

  it('wraps even a SINGLE sink once there is somewhere to report drops', () => {
    // The bare collapse would leave drop counting absent from the COMMON deployment shape —
    // one external destination — and an absent counter reads as "no drops".
    const sink = fakeSink()
    const composed = composeTraceSinks([sink], {
      operationalMetrics: createOperationalMetricsCollector(),
    })
    expect(composed).toBeInstanceOf(CompositeTraceSink)
  })

  it('returns the single sink verbatim (no wrapper) for exactly one', () => {
    const sink = fakeSink()
    expect(composeTraceSinks([undefined, sink])).toBe(sink)
  })

  it('wraps two or more in a CompositeTraceSink', () => {
    const composed = composeTraceSinks([fakeSink(), fakeSink()])
    expect(composed).toBeInstanceOf(CompositeTraceSink)
  })
})

describe('CompositeTraceSink', () => {
  it('fans generations and tool spans out to every sink', async () => {
    const a = fakeSink()
    const b = fakeSink()
    const composite = new CompositeTraceSink([a, b])

    await composite.recordGeneration(EVENT)
    await composite.recordToolSpans(CTX, SPANS)

    expect(a.gen).toHaveBeenCalledWith(EVENT)
    expect(b.gen).toHaveBeenCalledWith(EVENT)
    expect(a.tools).toHaveBeenCalledWith(CTX, SPANS)
    expect(b.tools).toHaveBeenCalledWith(CTX, SPANS)
  })

  it('isolates a failing sink so the others still receive the event', async () => {
    const boom = fakeSink()
    boom.gen.mockRejectedValue(new Error('down'))
    const ok = fakeSink()
    const composite = new CompositeTraceSink([boom, ok])

    await expect(composite.recordGeneration(EVENT)).resolves.toBeUndefined()
    expect(ok.gen).toHaveBeenCalledWith(EVENT)
  })

  it('counts and names a dropped export instead of swallowing it', async () => {
    // Telemetry completeness was the one property nothing anywhere measured: a deployment
    // whose collector had been rejecting every batch for a week looked exactly like one with
    // nothing to report. Still best-effort — the other sink and the caller are untouched.
    const boom = fakeSink()
    boom.gen.mockRejectedValue(new Error('collector rejected the batch'))
    const ok = fakeSink()
    const metrics = createOperationalMetricsCollector()
    const logger = createRecordingLogger()
    const composite = new CompositeTraceSink([boom, ok], { logger, operationalMetrics: metrics })

    await expect(composite.recordGeneration(EVENT)).resolves.toBeUndefined()
    expect(ok.gen).toHaveBeenCalledTimes(1)
    const dropped = metrics.drain().find((s) => s.counter === 'telemetry.export_dropped')
    expect(dropped).toEqual({
      counter: 'telemetry.export_dropped',
      dimensions: { operation: 'recordGeneration' },
      value: 1,
    })
    expect(logger.lines.some((l) => l.msg.includes('trace sink export dropped'))).toBe(true)
  })

  it("fans the settled run's parent spans out to every sink", async () => {
    const a = fakeSink()
    const b = fakeSink()
    const composite = new CompositeTraceSink([a, b])

    await composite.recordRunSpans(RUN, STEPS)

    expect(a.runSpans).toHaveBeenCalledWith(RUN, STEPS)
    expect(b.runSpans).toHaveBeenCalledWith(RUN, STEPS)
  })

  it('tolerates a sink without recordToolSpans or recordRunSpans', async () => {
    // Langfuse implements neither shape of parenting — its trace object already groups the
    // run — so the composite must treat both as absent rather than as a failure.
    const genOnly: LlmTraceSink = { recordGeneration: vi.fn() }
    const composite = new CompositeTraceSink([genOnly])
    await expect(composite.recordToolSpans(CTX, SPANS)).resolves.toBeUndefined()
    await expect(composite.recordRunSpans(RUN, STEPS)).resolves.toBeUndefined()
  })

  it('fans forceFlush/shutdown out to sinks that implement them, isolating failures', async () => {
    const flush = vi.fn()
    const stop = vi.fn().mockRejectedValue(new Error('down'))
    const withLifecycle: LlmTraceSink = {
      recordGeneration: vi.fn(),
      forceFlush: flush,
      shutdown: stop,
    }
    const bare: LlmTraceSink = { recordGeneration: vi.fn() } // no lifecycle methods
    const composite = new CompositeTraceSink([withLifecycle, bare])

    await expect(composite.forceFlush()).resolves.toBeUndefined()
    await expect(composite.shutdown()).resolves.toBeUndefined()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
