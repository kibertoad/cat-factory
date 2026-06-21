import { generateText } from 'ai'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/kernel'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import { systemPromptFor, userPromptFor } from './agent-catalog.js'
import { type AgentRouting, resolveAgentConfig, resolveStepModelRef } from './agent-routing.js'
import { composeBlockSystemPrompt } from './prompt-fragments.js'
import {
  type InlineWebSearchOptions,
  providerWebSearchTools,
  webResearchGuidanceFor,
} from './web-search.js'

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
  /**
   * Opt-in provider-hosted web search for the design/research inline kinds. When
   * supplied (and the resolved model's provider has a hosted search — Anthropic /
   * OpenAI), the allow-listed kinds get a `web_search` tool plus a usage nudge.
   * Absent ⇒ inline agents make a plain one-shot completion, exactly as before.
   */
  webSearch?: InlineWebSearchOptions
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
  private readonly webSearch?: InlineWebSearchOptions

  constructor({
    modelProvider,
    agentRouting,
    resolveBlockModel,
    resolveWorkspaceModelDefault,
    webSearch,
  }: AiAgentExecutorDependencies) {
    this.modelProvider = modelProvider
    this.agentRouting = agentRouting
    this.resolveBlockModel = resolveBlockModel ?? (() => undefined)
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
    this.webSearch = webSearch
  }

  /**
   * Resolve the step's model ref with the shared step precedence: a block's pinned
   * model wins, else the workspace's per-kind default, else the env routing for the
   * kind. Side-effect-free, so it backs both `run` and the up-front `resolveModel`.
   */
  private resolveRef(context: AgentRunContext): Promise<ModelRef> {
    return resolveStepModelRef(
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
  }

  /** Preview the model this step will run, without making the LLM call. */
  async resolveModel(context: AgentRunContext): Promise<string> {
    const ref = await this.resolveRef(context)
    return `${ref.provider}:${ref.model}`
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const config = resolveAgentConfig(this.agentRouting, context.agentKind)
    let ref = await this.resolveRef(context)
    // Subscription models (Claude Code / Codex) run ONLY in the container harness
    // with a pooled token — there is no provider key for them, so resolving one
    // through the ModelProvider here would either fail deep in the SDK or, worse,
    // call a different vendor's API with a CLI-only model id. A block's model is
    // shared by ALL its pipeline steps (container AND inline), so a task legitimately
    // pinned to a subscription model for its coder step would otherwise hard-fail its
    // inline steps (reviewer / requirements-rework / document-planner). Degrade
    // gracefully instead: fall back to this kind's env-routing default model (a
    // provider model the ModelProvider can serve) rather than failing the step.
    if (ref.harness && ref.harness !== 'pi') {
      ref = config.ref
    }
    const model = this.modelProvider.resolve(ref)

    // Base role prompt, then fold in the best-practice fragments selected for the
    // block — the engine-resolved tenant catalog when present, else the manual ids.
    const baseSystem = config.system ?? systemPromptFor(context.agentKind)
    const composed = composeBlockSystemPrompt(baseSystem, context.block)

    // Provider-hosted web search for the allow-listed design/research kinds, when
    // enabled AND the resolved provider has one. The usage nudge is appended only
    // when the tool is actually attached, so the model is never told about a tool
    // it lacks (mirrors the harness's AGENTS.md guidance gating).
    const tools =
      this.webSearch && this.webSearch.kinds.has(context.agentKind)
        ? providerWebSearchTools(ref.provider, this.webSearch.maxUses)
        : undefined
    // Inline tool is web_search only (no web_fetch); the per-kind hint is resolved
    // from the registry/catalog so a custom kind gets its own nudge.
    const system = tools
      ? `${composed}${webResearchGuidanceFor(context.agentKind, { fetch: false })}`
      : composed

    const { text, usage } = await generateText({
      model,
      system,
      prompt: userPromptFor(context),
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      ...(tools ? { tools } : {}),
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
