import { generateText } from 'ai'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/kernel'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import { systemPromptFor, userPromptFor } from './agent-catalog.js'
import { type AgentRouting, resolveAgentConfig, resolveStepModelRef } from './agent-routing.js'
import { composeBlockSystemPrompt } from './prompt-fragments.js'

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
  /**
   * Resolve the workspace's per-agent-kind default model id, consulted when the
   * block pins no usable model. Optional: absent → the env routing for the kind is
   * used. Supplying it makes the inline kinds honour the workspace defaults exactly
   * like the container executor (block-pinned > workspace default > env routing).
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
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
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>

  constructor({
    modelProvider,
    agentRouting,
    resolveBlockModel,
    resolveWorkspaceModelDefault,
  }: AiAgentExecutorDependencies) {
    this.modelProvider = modelProvider
    this.agentRouting = agentRouting
    this.resolveBlockModel = resolveBlockModel ?? (() => undefined)
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const config = resolveAgentConfig(this.agentRouting, context.agentKind)
    // The model is resolved with the shared step precedence: a block's pinned model
    // wins, else the workspace's per-kind default, else the env routing for the kind.
    const ref = await resolveStepModelRef(
      {
        agentRouting: this.agentRouting,
        resolveBlockModel: this.resolveBlockModel,
        resolveWorkspaceModelDefault: this.resolveWorkspaceModelDefault,
      },
      {
        agentKind: context.agentKind,
        blockModelId: context.block.modelId,
        workspaceId: context.workspaceId,
      },
    )
    const model = this.modelProvider.resolve(ref)

    // Base role prompt, then fold in the best-practice fragments selected for the
    // block — the engine-resolved tenant catalog when present, else the manual ids.
    const baseSystem = config.system ?? systemPromptFor(context.agentKind)
    const system = composeBlockSystemPrompt(baseSystem, context.block)

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
