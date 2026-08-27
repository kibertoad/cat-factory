import type { AgentRunContext, ModelProvider, ModelRef } from '@cat-factory/kernel'
import { AiAgentExecutor } from '@cat-factory/agents'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'

// The WIRING test for what an inline agent step REPORTS as its spend. The pure reading of the
// SDK's usage is covered where `agentUsageFromModelUsage` lives; this closes the gap between it
// and `run()`, because the split only matters if it survives the return: it is what the meter
// prices, and losing it silently charges a cache-heavy step at up to ten times its cost.

/** A provider whose model reports the usage handed in, in the SDK's own v3 shape. */
function providerReporting(usage: {
  total: number
  noCache?: number
  cacheRead?: number
  cacheWrite?: number
}): ModelProvider {
  return {
    resolve(_ref: ModelRef): ReturnType<ModelProvider['resolve']> {
      return new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: 'ok' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: usage,
            outputTokens: { total: 100, text: 100, reasoning: 0 },
          },
          warnings: [],
        }),
      }) as unknown as ReturnType<ModelProvider['resolve']>
    },
  }
}

function executorFor(provider: ModelProvider): AiAgentExecutor {
  return new AiAgentExecutor({
    modelProvider: provider,
    agentRouting: { default: { ref: { provider: 'anthropic', model: 'claude' } }, byKind: {} },
    resolveBlockModel: () => undefined,
    agentContextRecorder: undefined,
  })
}

const context: AgentRunContext = {
  agentKind: 'architect' as AgentRunContext['agentKind'],
  pipelineName: 'design',
  stepIndex: 0,
  isFinalStep: true,
  block: { title: 'A task', type: 'service', description: 'Do the thing' },
  priorOutputs: [],
  decisions: [],
  resolvedDecision: null,
}

describe('AiAgentExecutor reported token usage', () => {
  it('reports the input CLASS split a caching provider returned', async () => {
    const result = await executorFor(
      providerReporting({ total: 10_000, noCache: 1_500, cacheRead: 8_000, cacheWrite: 500 }),
    ).run(context)
    expect(result.usage).toEqual({
      inputTokens: 10_000,
      outputTokens: 100,
      inputClasses: { promptTokens: 1_500, cacheReadTokens: 8_000, cacheWriteTokens: 500 },
    })
  })

  it('reports NO split for a provider that said nothing about caching', async () => {
    // Absent is not zeroed: the meter then prices the lump at the fresh rate, which over-states
    // a cached call rather than under-stating it.
    const result = await executorFor(providerReporting({ total: 10_000, noCache: 10_000 })).run(
      context,
    )
    expect(result.usage).toEqual({ inputTokens: 10_000, outputTokens: 100 })
  })
})
