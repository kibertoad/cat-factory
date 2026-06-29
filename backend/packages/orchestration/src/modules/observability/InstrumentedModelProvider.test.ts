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

describe('InstrumentedModelProvider (inline feeder)', () => {
  it('emits one generation with mapped usage, model and the run context from providerOptions', async () => {
    const sink = new CaptureSink()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('hello world'),
      traceSink: sink,
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
    const provider = new InstrumentedModelProvider({ inner: mockProvider('x'), traceSink: sink })

    await generateText({ model: provider.resolve(ref), prompt: 'hi' })

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
    })

    await generateText({ model: provider.resolve(ref), prompt: 'sensitive' })

    const e = sink.events[0]!
    expect(e.input).toBe('')
    expect(e.output).toBe('')
    expect(e.promptTokens).toBe(100)
  })
})
