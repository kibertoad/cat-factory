import { describe, expect, it } from 'vitest'
import { generateText, jsonSchema, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModel } from 'ai'
import { createRecordingLogger } from '@cat-factory/kernel'
import type {
  InlineLlmCall,
  LlmGenerationEvent,
  LlmTraceSink,
  ModelProvider,
  ModelRef,
} from '@cat-factory/kernel'
import {
  InstrumentedModelProvider,
  catFactoryObservability,
  type WorkspaceBodiesGate,
} from './instrumented.js'

// The inline feeder. Every inline (non-proxied) LLM call must reach the same telemetry as the
// proxied container calls, through one of TWO exits — and EXACTLY ONE of them per call:
//
//   - `recordCall`, the metric recorder, whose `LlmObservabilityService` persists the row AND
//     fans out to the trace sink itself. A provider that took both exits would double every
//     inline generation on Langfuse/OTel.
//   - `traceSink`, for the un-tagged call the workspace-scoped store cannot file, and for a
//     deployment with a sink but no metric store.
//
// A provider that took NEITHER would silently drop the whole inline half of the platform's
// model activity, which is the gap this feeder closes (observability-logging-gaps.md, C2).
//
// Both exits are covered HERE, beside the class, rather than split across packages: these drive
// a real `generateText` over the SDK's own mock model through the wrapped provider, so the
// params/result shapes the readers parse are the ones the SDK actually produces rather than a
// hand-rolled stand-in that would rot silently at the next spec bump.

const ref: ModelRef = { provider: 'openai', model: 'gpt-4o-mini' }

class CaptureSink implements LlmTraceSink {
  events: LlmGenerationEvent[] = []
  recordGeneration(event: LlmGenerationEvent): void {
    this.events.push(event)
  }
}

/** The gate every workspace passes — the shape of a deployment with no stored opt-out. */
const allowBodies: WorkspaceBodiesGate = () => Promise.resolve(true)

const USAGE = {
  inputTokens: { total: 150, noCache: 100, cacheRead: 40, cacheWrite: 10 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
  totalTokens: 190,
}

/** A model that answers with `text` (plus an optional separate reasoning channel). */
function mockProvider(text: string, reasoning?: string): ModelProvider {
  const model: LanguageModel = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
        { type: 'text' as const, text },
      ],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: USAGE,
      warnings: [],
    }),
  })
  return { resolve: (_ref: ModelRef) => model }
}

/** A model whose generate rejects. */
function failingProvider(err: Error): ModelProvider {
  const model: LanguageModel = new MockLanguageModelV3({
    doGenerate: () => Promise.reject(err),
  })
  return { resolve: (_ref: ModelRef) => model }
}

/**
 * Both exits are dispatched WITHOUT being awaited (instrumentation must never extend the LLM
 * call), and each awaits at least one promise before it lands — so a test has to let the
 * microtask queue drain before reading what it captured.
 */
const flushEmit = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function collectors() {
  const recorded: InlineLlmCall[] = []
  const sink = new CaptureSink()
  return {
    recorded,
    sink,
    recordCall: (call: InlineLlmCall) => {
      recorded.push(call)
      return Promise.resolve()
    },
  }
}

/** Resolve an inline call's lazily-supplied bodies, as the recorder's service does. */
function bodiesOf(call: InlineLlmCall) {
  return {
    promptText: call.promptText(),
    responseText: call.responseText(),
    reasoningText: call.reasoningText(),
  }
}

describe('InstrumentedModelProvider — wiring', () => {
  // A harness-CLI model runs a whole tool loop behind ONE `doGenerate`, so it knows the calls this
  // middleware cannot see and files them itself. Wrapping it as well would add a lumped duplicate
  // to every step's rollup — and the duplicate is the LESS truthful of the two: one call for
  // sixteen, only once the subprocess exited, and zeros whenever the run was killed.
  it('leaves a model that reports its own calls unwrapped', async () => {
    const c = collectors()
    const selfReporting: LanguageModel = Object.assign(
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: 'from the CLI' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: USAGE,
          warnings: [],
        }),
      }),
      { reportsOwnLlmCalls: true },
    )
    const provider = new InstrumentedModelProvider({
      inner: { resolve: () => selfReporting },
      recordCall: c.recordCall,
      traceSink: c.sink,
      workspaceBodiesEnabled: allowBodies,
    })

    const resolved = provider.resolve(ref)
    // The very model, not a wrapper around it — the assertion that keeps a later change from
    // silently re-adding the duplicate.
    expect(resolved).toBe(selfReporting)

    await generateText({
      model: resolved,
      prompt: 'go',
      providerOptions: catFactoryObservability({ agentKind: 'doc-researcher', workspaceId: 'ws1' }),
    })
    await flushEmit()
    expect(c.recorded).toEqual([])
    expect(c.sink.events).toEqual([])
  })

  it('refuses to wrap a provider with no exit', () => {
    // A provider that instruments nothing is a wiring mistake wearing the wrapper's clothes:
    // every call pays the middleware and reaches nothing, while the facades' `instanceof`
    // wiring assertions still pass.
    expect(
      () =>
        new InstrumentedModelProvider({
          inner: mockProvider('x'),
          workspaceBodiesEnabled: allowBodies,
        }),
    ).toThrow(/at least one exit/)
  })
})

describe('InstrumentedModelProvider — the metric-recorder exit', () => {
  it('records a workspace-tagged call and does NOT also emit to the trace sink', async () => {
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('the answer', 'thinking'),
      recordCall: c.recordCall,
      traceSink: c.sink,
      workspaceBodiesEnabled: allowBodies,
      now: (() => {
        let t = 1000
        return () => (t += 500)
      })(),
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      maxOutputTokens: 4096,
      providerOptions: catFactoryObservability({
        agentKind: 'doc-researcher',
        workspaceId: 'ws_1',
        executionId: 'exec_1',
      }),
    })
    await flushEmit()

    expect(c.sink.events).toHaveLength(0)
    expect(c.recorded).toHaveLength(1)
    const call = c.recorded[0]!
    expect(call).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'exec_1',
      agentKind: 'doc-researcher',
      provider: 'openai',
      model: 'gpt-4o-mini',
      requestMaxTokens: 4096,
      // The three input classes stay orthogonal: `promptTokens` is the FRESH count.
      promptTokens: 100,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      completionTokens: 40,
      totalTokens: 190,
      finishReason: 'stop',
      durationMs: 500,
      ok: true,
      errorMessage: null,
    })
    expect(call.messageCount).toBeGreaterThan(0)
    const bodies = bodiesOf(call)
    expect(bodies.responseText).toBe('the answer')
    expect(bodies.reasoningText).toBe('thinking')
    expect(bodies.promptText).toContain('hi')
  })

  it("records NOTHING for the SDK's `other` placeholder when no vendor reason came with it", async () => {
    // `other` is the closed union's catch-all, so it is what a model answers when its backend named
    // no stop reason at all — every call a subscription CLI serves. That model files its own rows
    // with a null reason; without this the middleware's row (which a deployment with a trace sink
    // and no metric store still gets) claimed `other`, so one absence read as two different values.
    // A real `other` carries the vendor's own string in `raw` and is kept as-is.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: {
        resolve: () =>
          new MockLanguageModelV3({
            doGenerate: async () => ({
              content: [{ type: 'text' as const, text: 'done' }],
              finishReason: { unified: 'other' as const, raw: undefined },
              usage: USAGE,
              warnings: [],
            }),
          }),
      },
      recordCall: c.recordCall,
      workspaceBodiesEnabled: allowBodies,
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      providerOptions: catFactoryObservability({
        agentKind: 'doc-researcher',
        workspaceId: 'ws_1',
      }),
    })
    await flushEmit()

    expect(c.recorded[0]).toMatchObject({ ok: true, finishReason: null })
  })

  it('counts the tools the request offered', async () => {
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('done'),
      recordCall: c.recordCall,
      workspaceBodiesEnabled: allowBodies,
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      // A raw JSON Schema rather than a validation-library one: the SDK converts a tool's
      // schema to JSON Schema before dispatch and this package's own (valibot) has no
      // converter registered, which is a fact about the fixture, not about the reader.
      tools: {
        echo: tool({ description: 'echo', inputSchema: jsonSchema({ type: 'object' }) }),
        ping: tool({ description: 'ping', inputSchema: jsonSchema({ type: 'object' }) }),
      },
      providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'ws_1' }),
    })
    await flushEmit()

    expect(c.recorded[0]!.toolCount).toBe(2)
  })

  it('falls back to the trace sink for a call carrying no workspace', async () => {
    // The metric store is workspace-scoped, so an un-tagged call has no row to be filed
    // under. It must still reach the sink rather than vanish because a recorder is wired.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('x'),
      recordCall: c.recordCall,
      traceSink: c.sink,
      workspaceBodiesEnabled: allowBodies,
    })

    await generateText({ model: provider.resolve(ref), prompt: 'hi' })
    await flushEmit()

    expect(c.recorded).toHaveLength(0)
    expect(c.sink.events).toHaveLength(1)
    expect(c.sink.events[0]).toMatchObject({ workspaceId: null, agentKind: 'inline' })
  })

  it('attributes an untagged-run call to the SCOPE the provider was built for', async () => {
    // Ten of the twelve inline sites tag only the workspace, because the run is already in the
    // credential scope they resolved to lease with. Without this fallback those rows land with
    // a null execution id: in the store, but absent from `listByExecution`, a step's token
    // rollup and `/api/v1/debug/runs/*` — which reads as "this step spent nothing".
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('x'),
      recordCall: c.recordCall,
      workspaceBodiesEnabled: allowBodies,
      scopeExecutionId: 'exec_scope',
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      providerOptions: catFactoryObservability({
        agentKind: 'doc-interviewer',
        workspaceId: 'ws_1',
      }),
    })
    await flushEmit()

    expect(c.recorded[0]).toMatchObject({ executionId: 'exec_scope', agentKind: 'doc-interviewer' })
  })

  it('lets the per-call tag WIN over the scope (one scope can fan out across calls)', async () => {
    // A scope is per-provider, a tag is per-call: consensus resolves one scope and runs several
    // participants through it, so a caller that knows better must be able to say so.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('x'),
      recordCall: c.recordCall,
      workspaceBodiesEnabled: allowBodies,
      scopeExecutionId: 'exec_scope',
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      providerOptions: catFactoryObservability({
        agentKind: 'judge',
        workspaceId: 'ws_1',
        executionId: 'exec_tag',
      }),
    })
    await flushEmit()

    expect(c.recorded[0]!.executionId).toBe('exec_tag')
  })

  it('leaves the execution id null when neither the tag nor the scope names a run', async () => {
    // The honest answer for a genuinely un-run-scoped inline call (the document planner, a
    // bug-hunt rating, a fragment title) — never guessed at from anything else.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('x'),
      recordCall: c.recordCall,
      workspaceBodiesEnabled: allowBodies,
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      providerOptions: catFactoryObservability({
        agentKind: 'document-planner',
        workspaceId: 'ws_1',
      }),
    })
    await flushEmit()

    expect(c.recorded[0]!.executionId).toBeNull()
  })

  it('records a FAILED call with its cause and no bodies', async () => {
    // A failing inline call is exactly what an operator goes looking for, so it must land as
    // a row — with `ok: false` and the cause — rather than only as a thrown exception.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: failingProvider(new Error('upstream exploded')),
      recordCall: c.recordCall,
      workspaceBodiesEnabled: allowBodies,
    })

    await expect(
      generateText({
        model: provider.resolve(ref),
        prompt: 'hi',
        maxRetries: 0,
        providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'ws_1' }),
      }),
    ).rejects.toThrow('upstream exploded')
    await flushEmit()

    expect(c.recorded).toHaveLength(1)
    expect(c.recorded[0]).toMatchObject({ ok: false, finishReason: null })
    expect(c.recorded[0]!.errorMessage).toContain('upstream exploded')
    expect(bodiesOf(c.recorded[0]!)).toMatchObject({ responseText: '', reasoningText: '' })
  })

  it('passes bodies to the recorder UNGATED, and lazily', async () => {
    // The provider's own body gate governs the SINK exit only. Applying it here as well would
    // withhold text the metric store is entitled to keep and put one rule in two places, which
    // is how the sink half drifted open in the first place. The bodies arrive as thunks so
    // keeping the gate on the far side still costs a prompts-off deployment nothing.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('the answer'),
      recordCall: c.recordCall,
      recordPrompts: false,
      workspaceBodiesEnabled: () => Promise.resolve(false),
    })

    await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'opted-out' }),
    })
    await flushEmit()

    const call = c.recorded[0]!
    expect(typeof call.promptText).toBe('function')
    expect(call.responseText()).toBe('the answer')
  })

  it('never lets a failing recorder break the model call', async () => {
    const logger = createRecordingLogger()
    const provider = new InstrumentedModelProvider({
      inner: mockProvider('fine'),
      recordCall: () => Promise.reject(new Error('telemetry store down')),
      workspaceBodiesEnabled: allowBodies,
      logger,
    })

    const { text } = await generateText({
      model: provider.resolve(ref),
      prompt: 'hi',
      providerOptions: catFactoryObservability({ agentKind: 'judge', workspaceId: 'ws_1' }),
    })
    await flushEmit()

    expect(text).toBe('fine')
    expect(
      logger.lines.some((line) => line.level === 'warn' && line.msg.includes('recordInlineCall')),
    ).toBe(true)
  })
})

describe('InstrumentedModelProvider — the trace-sink exit', () => {
  it('emits one generation with mapped usage, model and the run context', async () => {
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
    expect(e.totalTokens).toBe(190)
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
    expect(e.totalTokens).toBe(190)
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
