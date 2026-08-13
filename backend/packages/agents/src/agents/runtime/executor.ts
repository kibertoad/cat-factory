import { generateText } from 'ai'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/kernel'
import type {
  AgentContextRecorder,
  DesignImageDelivery,
  Logger,
  ModelFlavor,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import { noopLogger, resolveDesignImageDelivery } from '@cat-factory/kernel'
import { recordInlineAgentContext } from './inline-context-record.js'
import { type AgentKindRegistry, defaultAgentKindRegistry } from '../kinds/registry.js'
import { standardsVerbosityFor } from '../kinds/traits.js'
import { systemPromptFor, userPromptFor } from '../catalog.js'
import { catFactoryObservability } from '../../providers/instrumented.js'
import { type AgentRouting, resolveAgentConfig, resolveInlineModelRef } from './routing.js'
import { composeBlockSystemPrompt } from './fragments.js'
import {
  type InlineWebSearchOptions,
  providerWebSearchTools,
  webResearchGuidanceFor,
} from './web-search.js'
import {
  type LoadedDesignImage,
  foldLoadedDesignImages,
  loadDesignImages,
} from './design-images.js'

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
  resolveBlockModel?: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
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
  /**
   * The account's binary-artifact store, for reading the bytes of the design pictures the engine
   * resolved for this dispatch. Only ever called when the resolved model accepts images AND the
   * context carries a set, so a deployment with no storage (which resolves no set in the first
   * place) never reaches it.
   *
   * Optional because an inline executor is servable without it: the run then keeps the textual
   * design description, and its prompt SAYS the pictures could not be delivered rather than
   * pretending the task had none.
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * The agent-context observability sink, so an inline dispatch records the complete context it
   * gave its agent exactly as a container dispatch does.
   *
   * Optional in the same sense as the container executor's: a facade that retains no telemetry
   * wires none. Its ABSENCE used to be the whole story though — nothing anywhere called this for
   * an inline kind — which is why the snapshot table held container kinds only and every reader
   * of it silently mis-explained the gap. See `inline-context-record.ts`.
   */
  agentContextRecorder?: AgentContextRecorder
  /** Where a dropped snapshot reports itself. Absent ⇒ `noopLogger`. */
  logger?: Logger
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
  private readonly resolveBlockModel: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  private readonly runsInline?: (ref: ModelRef) => boolean
  private readonly webSearch?: InlineWebSearchOptions
  private readonly agentKindRegistry: AgentKindRegistry
  private readonly resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  private readonly agentContextRecorder?: AgentContextRecorder
  private readonly log: Logger

  constructor({
    modelProviderResolver,
    modelProvider,
    agentRouting,
    resolveBlockModel,
    resolveWorkspaceModelDefault,
    runsInline,
    webSearch,
    agentKindRegistry,
    resolveBinaryArtifactStore,
    agentContextRecorder,
    logger,
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
    this.resolveBinaryArtifactStore = resolveBinaryArtifactStore
    this.agentContextRecorder = agentContextRecorder
    this.log = (logger ?? noopLogger).child({ scope: 'inlineAgentExecutor' })
  }

  /**
   * Settle what this inline call can do with the task's design pictures, and load the bytes when it
   * can carry them.
   *
   * An ordinary inline call carries them as MESSAGE PARTS whatever harness the ref names:
   * `harness: 'pi'` describes how a CONTAINER dispatch of that model is served, and here this
   * executor composes the model message itself.
   *
   * The ambient inline path (`runsInline`) carries them by NEITHER route, which is why it is a
   * refusal rather than a second carrier. The deployment serves the ref by driving its CLI as a
   * host subprocess: `CliInlineLanguageModel` flattens the prompt to system + user TEXT on stdin,
   * so an image part is dropped on the way out, and there is no checkout to write a file into
   * either. Reading the container answer for the same CLI (`claude-code` opens image files) is what
   * once left this path claiming `channel: 'files'` for a directory nothing ever wrote.
   */
  private async resolveDesignImages(
    context: AgentRunContext,
    ref: ModelRef,
  ): Promise<{
    context: Pick<AgentRunContext, 'designImages' | 'designImageDelivery'>
    images: LoadedDesignImage[]
  }> {
    const set = context.designImages
    if (!set?.files.length) return { context: {}, images: [] }
    const delivery: DesignImageDelivery = this.runsInline?.(ref)
      ? { attached: false, reason: 'inline_harness_text_only' }
      : resolveDesignImageDelivery({ channel: 'message' }, ref)
    if (!delivery.attached)
      return { context: { designImages: set, designImageDelivery: delivery }, images: [] }
    const resolveStore = this.resolveBinaryArtifactStore
    if (!resolveStore || !context.workspaceId) {
      // The set exists and this executor has no way to read its bytes: a facade that resolved
      // pictures and wired no store. Reported as the transfer failure it is, never as an
      // attachment of nothing.
      return {
        context: {
          designImages: set,
          designImageDelivery: { attached: false, reason: 'transfer_failed' },
        },
        images: [],
      }
    }
    const loaded = await loadDesignImages(resolveStore, context.workspaceId, set)
    return { context: foldLoadedDesignImages(set, loaded, delivery), images: loaded.images }
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
        // The preset's route order, resolved once per dispatch by the engine. Read off the
        // CONTEXT so this inline path and the container/consensus paths agree on the provider.
        ...(context.providerPreference ? { providerPreference: context.providerPreference } : {}),
        // And what the initiator declared about their own local models, for the same reason: this
        // path attaches design images as message parts, so it is one of the two readers of the
        // modality the fold puts on the ref.
        ...(context.localModelDeclarations
          ? { localModelDeclarations: context.localModelDeclarations }
          : {}),
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
    // The workspace's own prompt for this kind (resolved once per dispatch by the engine)
    // replaces the shipped track prompt; `systemPromptFor` still layers the engine-enforced
    // directives on top. It wins over the deployment-wide `AGENT_ROUTING` system prompt: the
    // workspace's edit is the more specific of the two.
    const baseSystem = context.systemPromptOverride
      ? systemPromptFor(context.agentKind, this.agentKindRegistry, context.systemPromptOverride)
      : (config.system ?? systemPromptFor(context.agentKind, this.agentKindRegistry))
    const composed = composeBlockSystemPrompt(
      baseSystem,
      context.block,
      this.agentKindRegistry.standardsDelivery(context.agentKind),
      // An inline call has no filesystem, so a `context-files` kind's standards were never
      // really delivered as files: fold them into the SYSTEM prompt here, at this kind's
      // verbosity. `userPromptFor` correspondingly leaves the standards files out of its own
      // fold, so each standard reaches the model exactly once and at the right length.
      false,
      standardsVerbosityFor(context.agentKind, this.agentKindRegistry),
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

    // The task's design pictures: whether this model can be shown them, and their bytes when it
    // can. Resolved BEFORE the prompt, because the prompt states what became of them.
    const design = await this.resolveDesignImages(context, ref)
    const promptContext: AgentRunContext = { ...context, ...design.context }
    const userPrompt = userPromptFor(promptContext, this.agentKindRegistry)

    // The complete provided context, filed exactly as the container executor files its own at
    // dispatch: this is the one point where the fully composed prompts and the folded fragment
    // bodies exist as one unit. Requires the run ids to file under; an executor invoked outside a
    // run (the benchmark harness) has none and records nothing.
    if (context.workspaceId && context.executionId) {
      await recordInlineAgentContext(this.agentContextRecorder, this.log, {
        context,
        ref,
        systemPrompt: system,
        userPrompt,
        workspaceId: context.workspaceId,
        executionId: context.executionId,
        harness: this.runsInline?.(ref) ? (ref.harness ?? null) : null,
      })
    }

    const { text, usage } = await generateText({
      model,
      system,
      // One user message carrying the prompt plus an image part per delivered picture, in the order
      // the prompt names them. A plain `prompt` string whenever there is nothing to attach, so
      // every run that carries no design is byte-identical on the wire to what it was before.
      ...(design.images.length
        ? {
            messages: [
              {
                role: 'user' as const,
                content: [
                  { type: 'text' as const, text: userPrompt },
                  ...design.images.map((image) => ({
                    type: 'image' as const,
                    image: image.data,
                    mediaType: image.mediaType,
                  })),
                ],
              },
            ],
          }
        : { prompt: userPrompt }),
      temperature: config.temperature,
      // The engine resolves the effective ceiling once per dispatch (step option > workspace
      // setting > this deployment default), so every executor path agrees on the budget. Absent
      // ⇒ the deployment routing default for the kind.
      maxOutputTokens: context.maxOutputTokens ?? config.maxOutputTokens,
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
