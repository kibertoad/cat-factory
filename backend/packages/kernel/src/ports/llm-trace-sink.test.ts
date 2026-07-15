import { describe, expect, it, vi } from 'vitest'
import type {
  LlmGenerationEvent,
  LlmToolSpan,
  LlmToolSpanContext,
  LlmTraceSink,
} from './llm-trace-sink.js'
import { CompositeTraceSink, composeTraceSinks } from './llm-trace-sink.js'

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

function fakeSink(): LlmTraceSink & {
  gen: ReturnType<typeof vi.fn>
  tools: ReturnType<typeof vi.fn>
} {
  const gen = vi.fn()
  const tools = vi.fn()
  return { recordGeneration: gen, recordToolSpans: tools, gen, tools }
}

describe('composeTraceSinks', () => {
  it('returns undefined for no sinks', () => {
    expect(composeTraceSinks([])).toBeUndefined()
    expect(composeTraceSinks([undefined, undefined])).toBeUndefined()
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

  it('tolerates a sink without recordToolSpans', async () => {
    const genOnly: LlmTraceSink = { recordGeneration: vi.fn() }
    const composite = new CompositeTraceSink([genOnly])
    await expect(composite.recordToolSpans(CTX, SPANS)).resolves.toBeUndefined()
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
