import { generateText } from 'ai'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/kernel'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import { type AgentKindRegistry, defaultAgentKindRegistry } from '../kinds/registry.js'
import { systemPromptFor, userPromptFor } from '../catalog.js'
import { catFactoryObservability } from '../../providers/instrumented.js'
import { type AgentRouting, resolveAgentConfig, resolveInlineModelRef } from './routing.js'
import { composeBlockSystemPrompt, standardsDeliveredAsFiles } from './fragments.js'
import {
  type InlineWebSearchOptions,
  providerWebSearchTools,
  webResearchGuidanceFor,
} from './web-search.js'

export interface AiAgentExecutorDependencies {
  /**
   * Resolve a {@link ModelProvider} for a run's credential scope (workspace + owning
   * account + initiator), leasing the DB-backed API keys for that scope. Preferred over
   * the static `modelProvider`; the facades supply it so inline calls use the same
   * per-scope pool the container proxy does.
   */
  modelProviderResolver?: ModelProviderResolver
  /**
   * A static {@link ModelProvider} (e.g. a fake in tests). Used only when no
   * `modelProviderResolver` is supplied. One of the two MUST be present.
   */
  modelProvider?: ModelProvider
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
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /**
   * Whether a container-only subscription harness ref can run as an INLINE call in this
   * deployment (local mode's ambient CLI). Supplied by the facade from
   * `config.agents.inlineHarnessRef`; keeps an ambient-eligible harness ref instead of
   * degrading it, so the harness-aware model provider serves it. Absent → always degrade.
   */
  runsInline?: (ref: ModelRef) => boolean
  /**
   * Opt-in provider-hosted web search for the design/research inline kinds. When
   * supplied (and the resolved model's provider has a hosted search — Anthropic /
   * OpenAI), the allow-listed kinds get a `web_search` tool plus a usage nudge.
   * Absent ⇒ inline agents make a plain one-shot completion, exactly as before.
   */
  webSearch?: InlineWebSearchOptions
  /**
   * The app-owned agent-kind registry the inline prompt builders read (custom kinds'
   * prompts / web-research hints). Defaults to a fresh {@link defaultAgentKindRegistry}
   * (built-ins only) when a facade doesn't inject one.
   */
  agentKindRegistry?: AgentKindRegistry
}

/**
 * The real agent: performs each pipeline step by calling an LLM through the
 * Vercel AI SDK. The model and generation settings come from the {@link
 * AgentRouting} (configurable per agent kind), and the concrete model is
 * resolved through the {@link ModelProvider} port — so this class never imports
 * a provider SDK or an API key directly.
 */
export class AiAgentExecutor implements AgentExecutor {
  private readonly modelProviderResolver?: ModelProviderResolver
  private readonly modelProvider?: ModelProvider
  private readonly agentRouting: AgentRouting
  private readonly resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  private readonly runsInline?: (ref: ModelRef) => boolean
  private readonly webSearch?: InlineWebSearchOptions
  private readonly agentKindRegistry: AgentKindRegistry

  constructor({
    modelProviderResolver,
    modelProvider,
    agentRouting,
    resolveBlockModel,
    resolveWorkspaceModelDefault,
    runsInline,
    webSearch,
    agentKindRegistry,
  }: AiAgentExecutorDependencies) {
    if (!modelProviderResolver && !modelProvider) {
      throw new Error('AiAgentExecutor requires a modelProviderResolver or a modelProvider')
    }
    this.modelProviderResolver = modelProviderResolver
    this.modelProvider = modelProvider
    this.agentRouting = agentRouting
    this.resolveBlockModel = resolveBlockModel ?? (() => undefined)
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
    this.runsInline = runsInline
    this.webSearch = webSearch
    this.agentKindRegistry = agentKindRegistry ?? defaultAgentKindRegistry()
  }

  /** Resolve the model provider for a run's scope (per-scope DB pool, else the static one). */
  private async providerFor(context: AgentRunContext): Promise<ModelProvider> {
    if (this.modelProviderResolver && context.workspaceId) {
      return this.modelProviderResolver.forScope({
        workspaceId: context.workspaceId,
        userId: context.initiatedByUserId,
        // The run this inline call belongs to, so a facade that serves a subscription ref
        // inline through a leased per-run activation (the container inline backend) can lease
        // the initiator's credential — the inline analogue of the container executor's lease.
        executionId: context.executionId,
      })
    }
    if (this.modelProvider) return this.modelProvider
    if (this.modelProviderResolver) {
      // No workspace scope (rare): lease from no scope — only the opt-in registries
      // (Cloudflare/Bedrock) can resolve.
      return this.modelProviderResolver.forScope({ workspaceId: context.workspaceId ?? '' })
    }
    throw new Error('AiAgentExecutor: no model provider available')
  }

  /**
   * Resolve the step's model ref with the shared step precedence: a block's pinned
   * model wins, else the workspace's per-kind default, else the env routing for the
   * kind. A pinned subscription model (Claude Code / Codex), which can run only in
   * the container harness, is degraded to the kind's env-routing default here — this
   * is an inline executor — via the shared `resolveInlineModelRef` seam. Side-effect-
   * free, so it backs both `run` and the up-front `resolveModel` (which thus reports
   * the model that will actually run, not the un-servable subscription ref).
   */
  private resolveRef(context: AgentRunContext): Promise<ModelRef> {
    return resolveInlineModelRef(
      {
        agentRouting: this.agentRouting,
        resolveBlockModel: this.resolveBlockModel,
        resolveWorkspaceModelDefault: this.resolveWorkspaceModelDefault,
        ...(this.runsInline ? { runsInline: this.runsInline } : {}),
      },
      {
        agentKind: context.agentKind,
        blockModelId: context.block.modelId,
        modelPresetId: context.block.modelPresetId,
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
    // `resolveRef` already degrades a pinned subscription model (Claude Code / Codex,
    // which run only in the container harness and have no provider key here) to this
    // kind's env-routing default, so the ModelProvider always gets a servable ref.
    const ref = await this.resolveRef(context)
    const provider = await this.providerFor(context)
    const model = provider.resolve(ref)

    // Base role prompt, then fold in the best-practice fragments selected for the
    // block — the engine-resolved tenant catalog when present, else the manual ids.
    const baseSystem = config.system ?? systemPromptFor(context.agentKind, this.agentKindRegistry)
    const composed = composeBlockSystemPrompt(
      baseSystem,
      context.block,
      this.agentKindRegistry.standardsDelivery(context.agentKind),
      standardsDeliveredAsFiles(context.injectedContextFiles),
    )

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
      ? `${composed}${webResearchGuidanceFor(context.agentKind, this.agentKindRegistry, { fetch: false })}`
      : composed

    const { text, usage } = await generateText({
      model,
      system,
      prompt: userPromptFor(context, this.agentKindRegistry),
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      ...(tools ? { tools } : {}),
      // Tag the call so an instrumented provider can group it under its run's trace
      // (a no-op when no trace sink is wired; ignored by every model provider).
      providerOptions: catFactoryObservability({
        agentKind: context.agentKind,
        workspaceId: context.workspaceId,
        executionId: context.executionId,
      }),
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
