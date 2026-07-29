import { describe, expect, it } from 'vitest'
import { catFactoryObservability } from '@cat-factory/kernel'
import type { InlineLlmCall, LlmGenerationEvent, ModelProvider } from '@cat-factory/kernel'
import { InstrumentedModelProvider } from './instrumented.js'

// The inline LLM feeder's two exits and the rule that EXACTLY ONE of them runs per call.
// The recorder's `LlmObservabilityService` fans out to the trace sink itself, so a provider
// that took both exits would double every inline generation on Langfuse/OTel — and a provider
// that took neither would silently drop the whole inline half of the platform's model activity,
// which is the gap this feeder closes (observability-logging-gaps.md, C2).

const ref = { provider: 'anthropic', model: 'claude-opus-4-8' }

/** A fake v3 model whose `doGenerate` returns a fixed result (or throws). */
function fakeModel(result: unknown, err?: Error) {
  return {
    specificationVersion: 'v3',
    provider: ref.provider,
    modelId: ref.model,
    supportedUrls: {},
    doGenerate: () => (err ? Promise.reject(err) : Promise.resolve(result)),
    doStream: () => Promise.reject(new Error('not used')),
  }
}

function providerOf(model: unknown): ModelProvider {
  return { resolve: () => model as ReturnType<ModelProvider['resolve']> }
}

const OK_RESULT = {
  content: [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'the answer' },
  ],
  finishReason: 'stop',
  usage: {
    inputTokens: { total: 150, noCache: 100, cacheRead: 40, cacheWrite: 10 },
    outputTokens: { total: 25 },
    totalTokens: 175,
  },
  warnings: [],
}

/** Drive one generate through the wrapped model, then let the best-effort emits settle. */
async function generate(provider: ModelProvider, params: Record<string, unknown>): Promise<void> {
  const model = provider.resolve(ref) as unknown as {
    doGenerate: (p: unknown) => Promise<unknown>
  }
  await model.doGenerate({
    prompt: [
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'text', text: 'u' }] },
    ],
    ...params,
  })
  // The emits are dispatched off the response path; yield so they land before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const tagged = catFactoryObservability({
  agentKind: 'doc-researcher',
  workspaceId: 'ws_1',
  executionId: 'exec_1',
})
const untagged = catFactoryObservability({ agentKind: 'doc-researcher' })

function collectors() {
  const recorded: InlineLlmCall[] = []
  const traced: LlmGenerationEvent[] = []
  return {
    recorded,
    traced,
    recordCall: (call: InlineLlmCall) => {
      recorded.push(call)
      return Promise.resolve()
    },
    traceSink: {
      recordGeneration: (event: LlmGenerationEvent) => {
        traced.push(event)
        return Promise.resolve()
      },
    },
  }
}

describe('InstrumentedModelProvider', () => {
  it('refuses to wrap a provider with no exit wired', () => {
    expect(
      () =>
        new InstrumentedModelProvider({
          inner: providerOf(fakeModel(OK_RESULT)),
          workspaceBodiesEnabled: () => Promise.resolve(true),
        }),
    ).toThrow(/at least one exit/)
  })

  it('records a workspace-tagged call and does NOT also emit to the trace sink', async () => {
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: providerOf(fakeModel(OK_RESULT)),
      recordCall: c.recordCall,
      traceSink: c.traceSink,
      workspaceBodiesEnabled: () => Promise.resolve(true),
    })
    await generate(provider, { providerOptions: tagged, maxOutputTokens: 4096, tools: [{}, {}] })

    expect(c.traced).toHaveLength(0)
    expect(c.recorded).toHaveLength(1)
    const call = c.recorded[0]!
    expect(call).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'exec_1',
      agentKind: 'doc-researcher',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      messageCount: 2,
      toolCount: 2,
      requestMaxTokens: 4096,
      // The three input classes stay orthogonal: `promptTokens` is the FRESH count.
      promptTokens: 100,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      completionTokens: 25,
      totalTokens: 175,
      finishReason: 'stop',
      ok: true,
      errorMessage: null,
      responseText: 'the answer',
      reasoningText: 'thinking',
    })
    expect(JSON.parse(call.promptText)).toHaveLength(2)
  })

  it('falls back to the trace sink for a call carrying no workspace', async () => {
    // The metric store is workspace-scoped, so an un-tagged call has no row to be filed
    // under. It must still reach the sink rather than vanish because a recorder is wired.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: providerOf(fakeModel(OK_RESULT)),
      recordCall: c.recordCall,
      traceSink: c.traceSink,
      workspaceBodiesEnabled: () => Promise.resolve(true),
    })
    await generate(provider, { providerOptions: untagged })

    expect(c.recorded).toHaveLength(0)
    expect(c.traced).toHaveLength(1)
    expect(c.traced[0]).toMatchObject({ workspaceId: null, agentKind: 'doc-researcher' })
  })

  it('records a FAILED call with its error and no bodies', async () => {
    // A failing inline call is exactly what an operator goes looking for, so it must land as
    // a row — with `ok: false` and the cause — rather than only as a thrown exception.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: providerOf(fakeModel(undefined, new Error('upstream exploded'))),
      recordCall: c.recordCall,
      workspaceBodiesEnabled: () => Promise.resolve(true),
    })
    const model = provider.resolve(ref) as unknown as {
      doGenerate: (p: unknown) => Promise<unknown>
    }
    await expect(model.doGenerate({ prompt: [], providerOptions: tagged })).rejects.toThrow(
      'upstream exploded',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(c.recorded).toHaveLength(1)
    expect(c.recorded[0]).toMatchObject({
      ok: false,
      errorMessage: 'upstream exploded',
      finishReason: null,
      responseText: '',
      reasoningText: '',
    })
  })

  it('passes bodies to the recorder UNGATED — the service owns that gate', async () => {
    // The provider's own body gate governs the SINK exit only. Applying it here as well would
    // withhold text the metric store is entitled to keep and put one rule in two places, which
    // is how the sink half drifted open in the first place.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: providerOf(fakeModel(OK_RESULT)),
      recordCall: c.recordCall,
      recordPrompts: false,
      workspaceBodiesEnabled: () => Promise.resolve(false),
    })
    await generate(provider, { providerOptions: tagged })

    expect(c.recorded[0]!.responseText).toBe('the answer')
  })

  it('never lets a failing recorder break the model call', async () => {
    const provider = new InstrumentedModelProvider({
      inner: providerOf(fakeModel(OK_RESULT)),
      recordCall: () => Promise.reject(new Error('telemetry store down')),
      workspaceBodiesEnabled: () => Promise.resolve(true),
    })
    await expect(generate(provider, { providerOptions: tagged })).resolves.toBeUndefined()
  })

  it('still emits to the sink alone when no recorder is wired', async () => {
    // The prior behaviour, unchanged: a deployment with a trace sink and no metric store.
    const c = collectors()
    const provider = new InstrumentedModelProvider({
      inner: providerOf(fakeModel(OK_RESULT)),
      traceSink: c.traceSink,
      workspaceBodiesEnabled: () => Promise.resolve(true),
    })
    await generate(provider, { providerOptions: tagged })

    expect(c.traced).toHaveLength(1)
    expect(c.traced[0]).toMatchObject({ workspaceId: 'ws_1', output: 'the answer' })
  })
})
