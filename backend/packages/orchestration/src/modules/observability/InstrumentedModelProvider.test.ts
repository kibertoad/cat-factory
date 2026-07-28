import { describe, expect, it } from 'vitest'
import { generateText } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModel } from 'ai'
import { InstrumentedModelProvider, catFactoryObservability } from '@cat-factory/agents'
import type { LlmGenerationEvent, LlmTraceSink, ModelProvider, ModelRef } from '@cat-factory/kernel'

// The inline feeder: every inline (non-proxied) LLM call must reach the SAME trace sink
// as the proxied container calls. InstrumentedModelProvider wraps the resolved model so
// `generateText` surfaces an LlmGenerationEvent — the identical type the proxy fan-out
// emits. These tests drive a real `generateText` over a mock model through the wrapped
// provider and assert the event the sink receives.

class CaptureSink implements LlmTraceSink {
  events: LlmGenerationEvent[] = []
  recordGeneration(event: LlmGenerationEvent): void {
    this.events.push(event)
  }
}

function mockProvider(text: string): ModelProvider {
  const model: LanguageModel = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 40, text: 40, reasoning: 0 },
      },
      warnings: [],
    }),
  })
  return { resolve: (_ref: ModelRef) => model }
}

const ref: ModelRef = { provider: 'openai', model: 'gpt-4o-mini' }

/** A gate that always allows body capture (the "no workspace opt-out wired" deployment). */
const allowBodies = async () => true

/**
 * The export is dispatched fire-and-forget (instrumentation must never extend the model
 * call), and the workspace gate adds an `await` before the sink is touched — so a test
 * asserting on the sink has to let the microtask queue drain first.
 */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('InstrumentedModelProvider (inline feeder)', () => {
  it('emits one generation with mapped usage, model and the run context from providerOptions', async () => {
    const sink = new CaptureSink()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('hello world'),
      traceSink: sink,
      bodiesEnabled: allowBodies,
      now: (() => {
        let t = 1000
        return () => (t += 500)
      })(),
    })

    const { text } = await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      providerOptions: catFactoryObservability({
        agentKind: 'requirements-review',
        workspaceId: 'ws1',
        executionId: 'exec1',
      }),
    })

    await flush()
    expect(text).toBe('hello world')
    expect(sink.events).toHaveLength(1)
    const e = sink.events[0]!
    expect(e.agentKind).toBe('requirements-review')
    expect(e.workspaceId).toBe('ws1')
    expect(e.executionId).toBe('exec1')
    expect(e.provider).toBe('openai')
    expect(e.model).toBe('gpt-4o-mini')
    expect(e.promptTokens).toBe(100)
    expect(e.completionTokens).toBe(40)
    expect(e.totalTokens).toBe(140)
    expect(e.ok).toBe(true)
    expect(e.output).toBe('hello world')
    expect(e.input).toContain('hi')
  })

  it('defaults to a standalone "inline" trace when no context is supplied', async () => {
    const sink = new CaptureSink()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('x'),
      traceSink: sink,
      bodiesEnabled: allowBodies,
    })

    await generateText({ model: provider.resolve(ref), prompt: 'hi' })
    await flush()

    const e = sink.events[0]!
    expect(e.agentKind).toBe('inline')
    expect(e.executionId).toBeNull()
    expect(e.workspaceId).toBeNull()
  })

  it('omits bodies when recordPrompts is false but keeps usage', async () => {
    const sink = new CaptureSink()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('secret output'),
      traceSink: sink,
      recordPrompts: false,
      bodiesEnabled: allowBodies,
    })

    await generateText({ model: provider.resolve(ref), prompt: 'sensitive' })
    await flush()

    const e = sink.events[0]!
    expect(e.input).toBe('')
    expect(e.output).toBe('')
    expect(e.promptTokens).toBe(100)
  })

  it('drops bodies for a workspace that turned `storeAgentContext` off, keeping usage', async () => {
    // The privacy half of the double gate. The proxied path has always consulted the
    // workspace toggle; the inline path consulted only `LLM_RECORD_PROMPTS`, so an opted-out
    // workspace still shipped its inline prompt AND response to Langfuse/OTel. Numeric
    // telemetry is deliberately unaffected (observability-logging-gaps.md, C2).
    const sink = new CaptureSink()
    const asked: (string | null)[] = []
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('secret output'),
      traceSink: sink,
      bodiesEnabled: async (workspaceId) => {
        asked.push(workspaceId)
        return false
      },
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'sensitive',
      providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'ws-optout' }),
    })
    await flush()

    expect(asked).toEqual(['ws-optout'])
    const e = sink.events[0]!
    expect(e.input).toBe('')
    expect(e.output).toBe('')
    expect(e.promptTokens).toBe(100)
    expect(e.totalTokens).toBe(140)
  })

  it('still exports the call when the gate itself throws, without breaking the model call', async () => {
    // Observability must never break agent work — but a gate that throws must not silently
    // export bodies either, so the whole export is dropped and reported rather than degraded.
    const sink = new CaptureSink()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('output'),
      traceSink: sink,
      bodiesEnabled: async () => {
        throw new Error('settings store unreachable')
      },
    })

    const { text } = await generateText({ model: provider.resolve(ref), prompt: 'hi' })
    await flush()

    expect(text).toBe('output')
    expect(sink.events).toHaveLength(0)
  })
})
