import { describe, expect, it } from 'vitest'
import { generateText } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModel } from 'ai'
import {
  InstrumentedModelProvider,
  catFactoryObservability,
  type WorkspaceBodiesGate,
} from '@cat-factory/agents'
import { createRecordingLogger } from '@cat-factory/kernel'
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

/** The gate every workspace passes — the shape of a deployment with no stored opt-out. */
const allowBodies: WorkspaceBodiesGate = () => Promise.resolve(true)

/**
 * The export is dispatched WITHOUT being awaited (instrumentation must never extend the
 * LLM call), and it now awaits the workspace body gate before handing the event to the
 * sink — so a test has to let the microtask queue drain before reading the sink.
 */
const flushEmit = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('InstrumentedModelProvider (inline feeder)', () => {
  it('emits one generation with mapped usage, model and the run context from providerOptions', async () => {
    const sink = new CaptureSink()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('hello world'),
      traceSink: sink,
      workspaceBodiesEnabled: allowBodies,
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
    await flushEmit()

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
      workspaceBodiesEnabled: allowBodies,
    })

    await generateText({ model: provider.resolve(ref), prompt: 'hi' })
    await flushEmit()

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
      workspaceBodiesEnabled: allowBodies,
    })

    await generateText({ model: provider.resolve(ref), prompt: 'sensitive' })
    await flushEmit()

    const e = sink.events[0]!
    expect(e.input).toBe('')
    expect(e.output).toBe('')
    expect(e.promptTokens).toBe(100)
  })

  // The C2 privacy bug: the proxied path gates bodies on LLM_RECORD_PROMPTS *and* the
  // workspace's `storeAgentContext` opt-out, but the inline path honoured only the former —
  // so an opted-out workspace kept shipping its inline prompts and responses to
  // Langfuse/OTel. Numeric telemetry is not privacy-sensitive and must survive the gate.
  it('withholds bodies for a workspace that opted out, still exporting usage', async () => {
    const sink = new CaptureSink()
    const asked: (string | null)[] = []
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('secret output'),
      traceSink: sink,
      workspaceBodiesEnabled: (workspaceId) => {
        asked.push(workspaceId)
        return Promise.resolve(workspaceId !== 'opted-out')
      },
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'sensitive',
      providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'opted-out' }),
    })
    await flushEmit()

    expect(asked).toEqual(['opted-out'])
    const e = sink.events[0]!
    expect(e.input).toBe('')
    expect(e.output).toBe('')
    expect(e.promptTokens).toBe(100)
    expect(e.totalTokens).toBe(140)
  })

  it('still exports bodies for a workspace that did not opt out', async () => {
    const sink = new CaptureSink()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('fine output'),
      traceSink: sink,
      workspaceBodiesEnabled: (workspaceId) => Promise.resolve(workspaceId !== 'opted-out'),
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hello',
      providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'ws-ok' }),
    })
    await flushEmit()

    const e = sink.events[0]!
    expect(e.input).toContain('hello')
    expect(e.output).toBe('fine output')
  })

  // An unreadable settings row is not consent. Failing OPEN would leak exactly the bodies
  // the gate exists to withhold; failing the whole export would lose the numeric telemetry
  // too, so the drop is reported and the usage still ships.
  it('fails closed and reports when the gate itself throws', async () => {
    const sink = new CaptureSink()
    const logger = createRecordingLogger()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('secret output'),
      traceSink: sink,
      logger,
      workspaceBodiesEnabled: () => Promise.reject(new Error('settings store down')),
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'sensitive',
      providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'ws1' }),
    })
    await flushEmit()

    const e = sink.events[0]!
    expect(e.input).toBe('')
    expect(e.output).toBe('')
    expect(e.promptTokens).toBe(100)
    expect(
      logger.lines.some(
        (line) => line.level === 'warn' && line.msg.includes('body-recording gate unreadable'),
      ),
    ).toBe(true)
  })
})
