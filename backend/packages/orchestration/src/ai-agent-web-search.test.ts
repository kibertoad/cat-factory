import type { AgentRunContext, ModelProvider, ModelRef } from '@cat-factory/kernel'
import { AiAgentExecutor, type InlineWebSearchOptions } from '@cat-factory/agents'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'

// The WIRING test for inline provider web search: it asserts the AiAgentExecutor
// actually attaches the `web_search` tool + appends the usage nudge to its one-shot
// `generateText` call for an allow-listed kind on a hosted-search provider — and does
// neither for a non-listed kind, a non-hosted provider, or when web search is off.
// (The pure pieces — env parsing, provider→tool selection, nudge text — are covered
// by inline-web-search.test.ts; this closes the gap between them and `run()`.)

/** A model provider whose model records the options `generateText` hands its `doGenerate`. */
function recordingProvider(): { provider: ModelProvider; captured: () => Record<string, unknown> } {
  let seen: Record<string, unknown> = {}
  const provider: ModelProvider = {
    resolve(_ref: ModelRef): ReturnType<ModelProvider['resolve']> {
      return new MockLanguageModelV3({
        doGenerate: async (options: Record<string, unknown>) => {
          seen = options
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }
        },
      }) as unknown as ReturnType<ModelProvider['resolve']>
    },
  }
  return { provider, captured: () => seen }
}

function executorFor(ref: ModelRef, webSearch?: InlineWebSearchOptions) {
  const { provider, captured } = recordingProvider()
  const exec = new AiAgentExecutor({
    modelProvider: provider,
    agentRouting: { default: { ref }, byKind: {} },
    resolveBlockModel: () => undefined,
    ...(webSearch ? { webSearch } : {}),
  })
  return { exec, captured }
}

function contextFor(agentKind: string): AgentRunContext {
  return {
    agentKind: agentKind as AgentRunContext['agentKind'],
    pipelineName: 'design',
    stepIndex: 0,
    isFinalStep: true,
    block: { title: 'A task', type: 'task', description: 'Do the thing' },
  }
}

/** Pull the system message text out of the recorded prompt (defensive about shape). */
function systemText(captured: Record<string, unknown>): string {
  const prompt = captured.prompt as Array<{ role?: string; content?: unknown }> | undefined
  const sys = prompt?.find((m) => m.role === 'system')
  return typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '')
}

function toolNames(captured: Record<string, unknown>): string[] {
  const tools = captured.tools as Array<{ name?: string }> | undefined
  if (!Array.isArray(tools)) return []
  return tools.map((t) => t.name ?? '')
}

const enabled: InlineWebSearchOptions = { kinds: new Set(['architect', 'researcher']), maxUses: 5 }

describe('AiAgentExecutor inline web search wiring', () => {
  it('attaches web_search + the nudge for an allow-listed kind on a hosted provider', async () => {
    const { exec, captured } = executorFor({ provider: 'anthropic', model: 'claude' }, enabled)
    await exec.run(contextFor('architect'))
    expect(toolNames(captured())).toContain('web_search')
    expect(systemText(captured())).toMatch(/web search/i)
  })

  it('attaches nothing for a kind outside the allow-list', async () => {
    const { exec, captured } = executorFor({ provider: 'anthropic', model: 'claude' }, enabled)
    await exec.run(contextFor('coder'))
    expect(toolNames(captured())).not.toContain('web_search')
    expect(systemText(captured())).not.toMatch(/## Web search/)
  })

  it('attaches nothing on a provider without a hosted search', async () => {
    // workers-ai has no server-executed search, so even an allow-listed kind runs
    // without web access (the deployment is unchanged).
    const { exec, captured } = executorFor({ provider: 'workers-ai', model: 'llama' }, enabled)
    await exec.run(contextFor('architect'))
    expect(toolNames(captured())).not.toContain('web_search')
    expect(systemText(captured())).not.toMatch(/## Web search/)
  })

  it('attaches nothing when web search is not enabled for the deployment', async () => {
    const { exec, captured } = executorFor({ provider: 'anthropic', model: 'claude' })
    await exec.run(contextFor('architect'))
    expect(toolNames(captured())).not.toContain('web_search')
    expect(systemText(captured())).not.toMatch(/## Web search/)
  })
})
