import { generateText } from 'ai'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '../../ports/agent-executor'
import type { ModelProvider } from '../../ports/model-provider'
import { systemPromptFor, userPromptFor } from './agent-catalog'
import { type AgentRouting, resolveAgentConfig } from './agent-routing'
import { composeSystemPrompt } from './prompt-fragments'

export interface AiAgentExecutorDependencies {
  modelProvider: ModelProvider
  agentRouting: AgentRouting
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

  constructor({ modelProvider, agentRouting }: AiAgentExecutorDependencies) {
    this.modelProvider = modelProvider
    this.agentRouting = agentRouting
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const config = resolveAgentConfig(this.agentRouting, context.agentKind)
    const model = this.modelProvider.resolve(config.ref)

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
      model: `${config.ref.provider}:${config.ref.model}`,
      // Report metered tokens so the spend safeguard can price this call. The
      // AI SDK leaves either field undefined when a provider omits it.
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
    }
  }
}
