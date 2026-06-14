import { generateText } from 'ai'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '../../ports/agent-executor'
import type { ModelProvider, ModelRef } from '../../ports/model-provider'
import { systemPromptFor, userPromptFor } from './agent-catalog'
import { type AgentRouting, resolveAgentConfig } from './agent-routing'
import { composeSystemPrompt } from './prompt-fragments'

export interface AiAgentExecutorDependencies {
  modelProvider: ModelProvider
  agentRouting: AgentRouting
  /**
   * Resolve a block's selected model id to a concrete ref. Deployment-aware (it
   * honours the direct/Cloudflare fallback based on configured keys), so the
   * worker supplies it; absent/unknown ids return undefined to fall back to the
   * agent routing. Defaults to "no per-block override".
   */
  resolveBlockModel?: (modelId: string | undefined) => ModelRef | undefined
}

/**
 * The real agent: performs each pipeline step by calling an LLM through the
 * Vercel AI SDK. The model and generation settings come from the {@link
 * AgentRouting} (configurable per agent kind), and the concrete model is
 * resolved through the {@link ModelProvider} port — so this class never imports
 * a provider SDK or an API key directly.
 */
export class AiAgentExecutor implements AgentExecutor {
  private readonly modelProvider: ModelProvider
  private readonly agentRouting: AgentRouting
  private readonly resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined

  constructor({ modelProvider, agentRouting, resolveBlockModel }: AiAgentExecutorDependencies) {
    this.modelProvider = modelProvider
    this.agentRouting = agentRouting
    this.resolveBlockModel = resolveBlockModel ?? (() => undefined)
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const config = resolveAgentConfig(this.agentRouting, context.agentKind)
    // A model picked for the block overrides the routing default; an unknown or
    // absent selection falls back to the configured routing for the agent kind.
    const ref = this.resolveBlockModel(context.block.modelId) ?? config.ref
    const model = this.modelProvider.resolve(ref)

    // Base role prompt, then fold in any best-practice fragments selected for the block.
    const baseSystem = config.system ?? systemPromptFor(context.agentKind)
    const system = composeSystemPrompt(baseSystem, context.block.fragmentIds)

    const { text, usage } = await generateText({
      model,
      system,
      prompt: userPromptFor(context),
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
    })

    return {
      output: text.trim(),
      model: `${ref.provider}:${ref.model}`,
      // Report metered tokens so the spend safeguard can price this call. The
      // AI SDK leaves either field undefined when a provider omits it.
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
    }
  }
}
