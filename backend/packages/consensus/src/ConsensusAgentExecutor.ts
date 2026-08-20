import {
  type AgentExecutor,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  type ConsensusSession,
  type ConsensusSessionRepository,
  type ConsensusStrategy,
  describeError,
  type ExecutionEventPublisher,
  getErrorMessage,
  inlineModelRef,
  isAsyncAgentExecutor,
  type Logger,
  type ModelFlavor,
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  type RunReclaimTarget,
} from '@cat-factory/kernel'
import type { DispatchToolServers } from '@cat-factory/contracts'
import {
  type AgentKindRegistry,
  type AgentRouting,
  composeBlockSystemPrompt,
  defaultAgentKindRegistry,
  INLINE_PANEL_SURFACE,
  resolveAgentConfig,
  resolveInlineModelRef,
  standardsVerbosityFor,
  systemPromptFor,
  traitDeliveryFor,
  userPromptFor,
} from '@cat-factory/agents'
import { decideConsensusMode } from './gating.js'
import { panelDesignImageCeiling } from './designImages.js'
import { panelToolServerCeiling } from './toolServers.js'
import { isConsensusEligible } from './traits.js'
import { runSpecialistPanel } from './strategies/specialistPanel.js'
import { runDebate } from './strategies/debate.js'
import { runRankedVoting } from './strategies/rankedVoting.js'
import { defaultGenerate } from './strategies/shared.js'
import type {
  GenerateFn,
  ResolvedParticipant,
  StrategyInput,
  StrategyResult,
} from './strategies/types.js'

export interface ConsensusAgentExecutorDependencies {
  /**
   * The standard executor (typically the `CompositeAgentExecutor`) consensus wraps and
   * DELEGATES to: when a step is not consensus-enabled, or gating marks the task
   * ineligible, the standard single-actor agent runs exactly as before (preserving the
   * container/async path for kinds that need a checkout).
   */
  standard: AgentExecutor
  /** Per-scope model provider (preferred); leases the run's DB-backed API keys. */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (tests / no pool). One of the two MUST be present. */
  modelProvider?: ModelProvider
  agentRouting: AgentRouting
  resolveBlockModel?: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  /**
   * Whether a container-only subscription harness ref (`claude-code` / `codex`) can run as an
   * INLINE call in this deployment (local mode's ambient CLI). Consensus runs its participants
   * INLINE, so — like the other inline callers — it must KEEP an ambient-eligible harness ref
   * instead of degrading it to the routing default, otherwise a subscription-only participant
   * model strands on the unconfigured fallback provider. From `config.agents.inlineHarnessRef`;
   * absent on Node/Worker (no inline harness path → degrade, as before).
   */
  runsInline?: (ref: ModelRef) => boolean
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /** Persists the session transcript (the observability surface). Optional. */
  sessionRepository?: ConsensusSessionRepository
  /** Pushes live transcript updates to the SPA. Optional. */
  eventPublisher?: ExecutionEventPublisher
  /** Epoch-ms clock; defaults to Date.now. */
  now?: () => number
  /** Structured logger; optional. */
  logger?: Logger
  /** Inject the LLM call (tests); defaults to the Vercel AI SDK wrapper. */
  generate?: GenerateFn
  /**
   * The app-owned agent-kind registry: consulted for consensus eligibility (a registered
   * kind's traits) and the participants' base system/goal prompts. Defaults to a fresh
   * {@link defaultAgentKindRegistry} (built-ins only) when a facade doesn't inject one.
   */
  agentKindRegistry?: AgentKindRegistry
}

const STRATEGIES: Record<ConsensusStrategy, (input: StrategyInput) => Promise<StrategyResult>> = {
  'specialist-panel': runSpecialistPanel,
  debate: runDebate,
  'ranked-voting': runRankedVoting,
}

/**
 * An {@link AgentExecutor} that runs an eligible, consensus-enabled step through a
 * multi-model consensus process (specialist panel / debate / ranked voting), persisting
 * the transcript and returning a normal {@link AgentRunResult} of the SAME shape the
 * underlying agent kind would have produced — so the rest of the engine is untouched.
 * Every other step delegates to the wrapped standard executor.
 */
export class ConsensusAgentExecutor implements AsyncAgentExecutor {
  private readonly deps: ConsensusAgentExecutorDependencies
  private readonly resolveBlockModel: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  private readonly now: () => number
  private readonly generate: GenerateFn
  private readonly agentKindRegistry: AgentKindRegistry

  constructor(deps: ConsensusAgentExecutorDependencies) {
    if (!deps.modelProviderResolver && !deps.modelProvider) {
      throw new Error('ConsensusAgentExecutor requires a modelProviderResolver or a modelProvider')
    }
    this.deps = deps
    this.resolveBlockModel = deps.resolveBlockModel ?? (() => undefined)
    this.now = deps.now ?? (() => Date.now())
    this.generate = deps.generate ?? defaultGenerate
    this.agentKindRegistry = deps.agentKindRegistry ?? defaultAgentKindRegistry()
  }

  /**
   * Whether this step should actually run consensus (enabled, the kind carries a
   * consensus capability trait, ≥2 participants, gate passes). The eligibility check
   * is the runtime backstop for the builder's UI guard: a pipeline crafted via the
   * API with a consensus config on an INELIGIBLE kind (e.g. the container `coder`,
   * which must clone/edit/commit/PR) must NOT be diverted to an inline multi-model
   * panel — it falls through to the standard executor unchanged.
   */
  private consensusActive(context: AgentRunContext): boolean {
    const cfg = context.consensus
    if (!cfg || !cfg.enabled) return false
    if (!isConsensusEligible(context.agentKind, this.agentKindRegistry)) return false
    if (cfg.participants.length < 2) return false
    return decideConsensusMode(context.block.estimate, cfg.gating) === 'consensus'
  }

  private async providerFor(context: AgentRunContext): Promise<ModelProvider> {
    if (this.deps.modelProviderResolver && context.workspaceId) {
      return this.deps.modelProviderResolver.forScope({
        workspaceId: context.workspaceId,
        userId: context.initiatedByUserId,
        // Carry the run so a leased-per-run inline subscription backend can lease the
        // initiator's activation for a consensus participant's inline call.
        executionId: context.executionId,
      })
    }
    if (this.deps.modelProvider) return this.deps.modelProvider
    if (this.deps.modelProviderResolver) {
      return this.deps.modelProviderResolver.forScope({ workspaceId: context.workspaceId ?? '' })
    }
    throw new Error('ConsensusAgentExecutor: no model provider available')
  }

  private baseRef(context: AgentRunContext): Promise<ModelRef> {
    return resolveInlineModelRef(
      {
        agentRouting: this.deps.agentRouting,
        resolveBlockModel: this.resolveBlockModel,
        resolveWorkspaceModelDefault: this.deps.resolveWorkspaceModelDefault,
        // In local mode keep an ambient-eligible subscription harness ref (served inline via
        // the CLI) instead of degrading it to the routing default; undefined on Node/Worker.
        ...(this.deps.runsInline ? { runsInline: this.deps.runsInline } : {}),
      },
      {
        agentKind: context.agentKind,
        blockModelId: context.block.modelId,
        modelPresetId: context.block.modelPresetId,
        workspaceId: context.workspaceId,
        // The preset's route order, resolved once per dispatch by the engine. Read off the
        // CONTEXT so a panel's participants run on the same providers the single-actor path
        // would have used for the same step.
        ...(context.providerPreference ? { providerPreference: context.providerPreference } : {}),
        // The initiator's local-model declarations, threaded for consistency with the other two
        // paths. A panel withholds design images for its OWN reason (`consensus_panel`: one
        // composed prompt across models that need not agree), so nothing here reads the modality
        // today, but a base ref that answered differently per executor is exactly the drift the
        // per-dispatch resolution exists to prevent.
        ...(context.localModelDeclarations
          ? { localModelDeclarations: context.localModelDeclarations }
          : {}),
      },
    )
  }

  /** A participant/synthesizer's ref: its pinned model (degraded for inline) else the base ref. */
  private refForModelId(
    modelId: string | undefined,
    base: ModelRef,
    providerPreference?: readonly ModelFlavor[],
  ): ModelRef {
    if (modelId) {
      const pinned = this.resolveBlockModel(modelId, providerPreference)
      if (pinned)
        return inlineModelRef(
          pinned,
          base,
          this.deps.runsInline ? { runsInline: this.deps.runsInline } : {},
        )
    }
    return base
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    if (!this.consensusActive(context)) return this.deps.standard.run(context)
    const cfg = context.consensus!

    const provider = await this.providerFor(context)
    const base = await this.baseRef(context)
    const config = resolveAgentConfig(this.deps.agentRouting, context.agentKind)
    const composedSystem = composeBlockSystemPrompt(
      // Same precedence the single-actor inline executor applies: the workspace's own prompt
      // for this kind wins over the deployment-wide `AGENT_ROUTING` system prompt, and
      // `systemPromptFor` re-applies the engine-enforced directives on top of it.
      // The delivered `.cat-context/` paths ride along for the same reason the single-actor
      // inline executor passes them: a panel participant has no filesystem and reads the same
      // files folded into its USER prompt, so guidance naming one must not point at nothing.
      context.systemPromptOverride
        ? systemPromptFor(
            context.agentKind,
            this.agentKindRegistry,
            context.systemPromptOverride,
            traitDeliveryFor(context),
          )
        : (config.system ??
            systemPromptFor(
              context.agentKind,
              this.agentKindRegistry,
              undefined,
              traitDeliveryFor(context),
            )),
      context.block,
      this.agentKindRegistry.standardsDelivery(context.agentKind),
      // An inline call has no filesystem, so a `context-files` kind's standards were never
      // really delivered as files: fold them into the SYSTEM prompt here, at this kind's
      // verbosity. `userPromptFor` correspondingly leaves the standards files out of its own
      // fold, so each standard reaches the model exactly once and at the right length.
      false,
      // Same per-kind verbosity the single-actor executors resolve: a consensus session runs the
      // SAME kind, so an implementer kind must not silently regain the full standards here.
      standardsVerbosityFor(context.agentKind, this.agentKindRegistry),
    )
    // Most consensus-eligible kinds are CONTAINER kinds whose shipped prompt is written for a
    // real checkout (run `git diff`, read `.cat-context/*`, dispatch slice subagents). A panel
    // participant is a plain inline call with none of that, so the surface it is actually on is
    // stated last — after any workspace override, which must not be able to drop it.
    //
    // The tool servers the kind declared go the same way, and are NAMED rather than covered by the
    // paragraph above: the surface statement tells a participant it has no CLI, which does not tell
    // it that the vendor tool its instructions send it to is one of the things it has lost.
    // Recomputed rather than threaded from the preview the engine already asked for, the same way
    // the model is resolved twice: a pure read of the kind's declarations, and the alternative is
    // an executor holding per-dispatch state between two port calls.
    const ceiling = panelToolServerCeiling(context, this.agentKindRegistry, this.deps.logger)
    if (ceiling.record) {
      this.deps.logger?.warn('consensus panel withholds the tool servers this kind declares', {
        agentKind: context.agentKind,
        strategy: cfg.strategy,
        executionId: context.executionId,
        stepIndex: context.stepIndex,
        toolServerIds: ceiling.record.unavailable.map((server) => server.id),
      })
    }
    const baseSystem = ceiling.section
      ? `${composedSystem}\n\n${INLINE_PANEL_SURFACE}\n\n${ceiling.section}`
      : `${composedSystem}\n\n${INLINE_PANEL_SURFACE}`
    // Composed from the context PLUS what this surface cannot carry, so the one shared goal prompt
    // states a withheld design exactly as the container dispatch of the same kind would state an
    // undeliverable one. Absent for a task with no linked design: the prompt is then unchanged.
    const goalPrompt = userPromptFor(
      { ...context, ...panelDesignImageCeiling(context) },
      this.agentKindRegistry,
    )

    const participants: ResolvedParticipant[] = cfg.participants.map((p) => {
      const ref = this.refForModelId(p.modelId, base, context.providerPreference)
      return {
        id: p.id,
        role: p.role,
        ...(p.systemFraming ? { systemFraming: p.systemFraming } : {}),
        model: provider.resolve(ref),
        modelLabel: `${ref.provider}:${ref.model}`,
      }
    })
    const synthRef = this.refForModelId(cfg.synthesizerModelId, base, context.providerPreference)
    const synthesizer = {
      model: provider.resolve(synthRef),
      modelLabel: `${synthRef.provider}:${synthRef.model}`,
    }

    const session: ConsensusSession = {
      id: `cns_${context.executionId ?? 'x'}_${context.stepIndex}`,
      blockId: context.block.id ?? '',
      executionId: context.executionId ?? null,
      stepIndex: context.stepIndex,
      agentKind: context.agentKind,
      strategy: cfg.strategy,
      status: 'running',
      // Which workspace consensus GROUP the engine selected for this dispatch, when the step
      // named a tier set. Copied onto the transcript (rather than looked up later) so the
      // session still says which panel fired after the library row is edited or deleted.
      groupId: cfg.selectedGroup?.id ?? null,
      groupName: cfg.selectedGroup?.name ?? null,
      participants: cfg.participants,
      rounds: [],
      synthesis: null,
      confidence: null,
      dissent: [],
      error: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    await this.emit(context, session)
    this.deps.logger?.info('consensus session started', {
      msg: 'consensus.start',
      strategy: cfg.strategy,
      agentKind: context.agentKind,
      participants: participants.length,
      executionId: context.executionId,
      stepIndex: context.stepIndex,
    })

    const tags = {
      agentKind: context.agentKind,
      workspaceId: context.workspaceId,
      executionId: context.executionId,
    }
    try {
      const result = await STRATEGIES[cfg.strategy]({
        agentKind: context.agentKind,
        baseSystem,
        goalPrompt,
        participants,
        synthesizer,
        rounds: cfg.rounds ?? 2,
        generate: this.generate,
        tags,
        onProgress: async (update) => {
          session.rounds = update.rounds
          session.status = update.status
          session.updatedAt = this.now()
          await this.emit(context, session)
        },
      })
      session.rounds = result.rounds
      session.synthesis = result.synthesis
      session.confidence = result.confidence
      session.dissent = result.dissent
      session.status = 'done'
      session.updatedAt = this.now()
      await this.emit(context, session)
      this.deps.logger?.info('consensus session complete', {
        msg: 'consensus.done',
        strategy: cfg.strategy,
        confidence: result.confidence,
      })
      return {
        output: result.synthesis,
        model: `consensus:${cfg.strategy}:${synthesizer.modelLabel}`,
        usage: result.usage,
      }
    } catch (error) {
      session.status = 'failed'
      session.error = getErrorMessage(error)
      session.updatedAt = this.now()
      await this.emit(context, session)
      this.deps.logger?.warn('consensus session failed', {
        sessionId: session.id,
        ...describeError(error),
      })
      throw error
    }
  }

  private async emit(context: AgentRunContext, session: ConsensusSession): Promise<void> {
    if (!context.workspaceId) return
    try {
      await this.deps.sessionRepository?.upsert(context.workspaceId, session)
    } catch {
      // Persistence is best-effort observability; never wedge the run.
    }
    try {
      await this.deps.eventPublisher?.consensusSessionChanged?.(context.workspaceId, session)
    } catch {
      // Push is best-effort.
    }
  }

  async resolveModel(context: AgentRunContext): Promise<string | undefined> {
    if (!this.consensusActive(context)) {
      return this.deps.standard.resolveModel?.(context) ?? Promise.resolve(undefined)
    }
    const base = await this.baseRef(context)
    const ref = this.refForModelId(
      context.consensus!.synthesizerModelId,
      base,
      context.providerPreference,
    )
    return `consensus:${context.consensus!.strategy}:${ref.provider}:${ref.model}`
  }

  isQuotaBased(context: AgentRunContext): Promise<boolean> {
    // Consensus makes metered inline calls; only the delegated path can be quota-based.
    if (this.consensusActive(context)) return Promise.resolve(false)
    return this.deps.standard.isQuotaBased?.(context) ?? Promise.resolve(false)
  }

  /**
   * The tool-server ceiling of a diverted step, answered at DISPATCH so the engine records it
   * before the panel runs. A panel that throws still leaves a step saying what it could not reach,
   * which is the state a reader most needs it in: without the record, a failed diverted step is
   * indistinguishable from an ordinary inline step whose kind declared no servers.
   *
   * Reads the declarations only, which is what makes it cheap enough to sit ahead of the work: no
   * transport, credential or harness test can change the answer on this surface, and running them
   * would resolve credentials for a dispatch that has nowhere to send them.
   */
  previewToolServers(context: AgentRunContext): Promise<DispatchToolServers | undefined> {
    if (!this.consensusActive(context)) {
      return this.deps.standard.previewToolServers?.(context) ?? Promise.resolve(undefined)
    }
    return Promise.resolve(
      panelToolServerCeiling(context, this.agentKindRegistry, this.deps.logger).record,
    )
  }

  // --- Async delegation: only ever reached for non-consensus (delegated) steps, since
  // `runsAsync` returns false while consensus is active (forcing the engine's inline path).

  runsAsync(context: AgentRunContext): boolean {
    if (this.consensusActive(context)) return false
    return isAsyncAgentExecutor(this.deps.standard) && this.deps.standard.runsAsync(context)
  }

  startJob(context: AgentRunContext): Promise<AgentJobHandle> {
    if (!isAsyncAgentExecutor(this.deps.standard)) {
      throw new Error(`No async executor for agent kind '${context.agentKind}'`)
    }
    return this.deps.standard.startJob(context)
  }

  pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    if (!isAsyncAgentExecutor(this.deps.standard)) {
      throw new Error('Wrapped executor does not support async jobs')
    }
    return this.deps.standard.pollJob(handle)
  }

  async reclaimRun(target: RunReclaimTarget): Promise<void> {
    if (isAsyncAgentExecutor(this.deps.standard) && this.deps.standard.reclaimRun) {
      await this.deps.standard.reclaimRun(target)
    }
  }
}
