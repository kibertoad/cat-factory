import type { AgentRunContext, ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { UsageAttribution } from '@cat-factory/agents'
import { AiAgentExecutor } from '@cat-factory/agents'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'

// The WIRING test for what an inline agent step REPORTS as its spend: how much it cost, and who
// pays for it. The pure reading of the SDK's usage is covered where `agentUsageFromModelUsage`
// lives; this closes the gap between it and `run()`, because neither answer matters unless it
// survives the return. The split is what the meter prices, and losing it silently charges a
// cache-heavy step at up to ten times its cost. The BILLING is what keeps a subscription step out
// of the budget rollups, and losing it filed a whole deployment's inline steps as money spent.

/**
 * A provider whose model reports the usage handed in, in the SDK's own v3 shape, and (when one is
 * given) declares the billing attribution of the credential behind it, exactly as the local
 * facade's subscription CLI model does.
 */
function providerReporting(
  usage: {
    total: number
    noCache?: number
    cacheRead?: number
    cacheWrite?: number
  },
  attribution?: UsageAttribution,
): ModelProvider {
  return {
    resolve(_ref: ModelRef): ReturnType<ModelProvider['resolve']> {
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: 'ok' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: {
              total: usage.total,
              noCache: usage.noCache,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            },
            outputTokens: { total: 100, text: 100, reasoning: 0 },
          },
          warnings: [],
        }),
      })
      const resolved = attribution ? Object.assign(model, { usageAttribution: attribution }) : model
      return resolved as unknown as ReturnType<ModelProvider['resolve']>
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

  it('reports the billing the resolved model declares, not the path it ran on', async () => {
    // The regression: an inline step served by a subscription harness used to report nothing
    // here, so the ledger's `'metered'` default filed it as per-token money on a deployment
    // holding no metered credential at all.
    const result = await executorFor(
      providerReporting(
        { total: 10_000, noCache: 10_000 },
        {
          billing: 'subscription',
          vendor: 'anthropic',
        },
      ),
    ).run(context)
    expect(result.usageBilling).toBe('subscription')
    expect(result.usageVendor).toBe('anthropic')
  })

  it('leaves the billing to the ledger for a model that declares none', async () => {
    // A plain provider API key IS metered, and saying so here rather than leaving it absent
    // would put this executor in the business of asserting a fact it did not resolve.
    const result = await executorFor(providerReporting({ total: 10_000, noCache: 10_000 })).run(
      context,
    )
    expect(result.usageBilling).toBeUndefined()
    expect(result.usageVendor).toBeUndefined()
  })
})
