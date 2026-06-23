import {
  type AgentExecutor,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  type ConsensusSession,
  type ConsensusStrategy,
  type ConsensusSessionRepository,
  type ExecutionEventPublisher,
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  inlineModelRef,
  isAsyncAgentExecutor,
} from '@cat-factory/kernel'
import {
  type AgentRouting,
  composeBlockSystemPrompt,
  resolveAgentConfig,
  resolveInlineModelRef,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import { decideConsensusMode } from './gating.js'
import { runSpecialistPanel } from './strategies/specialistPanel.js'
import { runDebate } from './strategies/debate.js'
import { runRankedVoting } from './strategies/rankedVoting.js'
import { defaultGenerate } from './strategies/shared.js'
import type { GenerateFn, ResolvedParticipant, StrategyInput, StrategyResult } from './strategies/types.js'

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
  resolveBlockModel?: (modelId: string | undefined) => ModelRef | undefined
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
  /** Persists the session transcript (the observability surface). Optional. */
  sessionRepository?: ConsensusSessionRepository
  /** Pushes live transcript updates to the SPA. Optional. */
  eventPublisher?: ExecutionEventPublisher
  /** Epoch-ms clock; defaults to Date.now. */
  now?: () => number
  /** Structured logger; optional. */
  logger?: { info(obj: unknown, msg?: string): void; warn?(obj: unknown, msg?: string): void }
  /** Inject the LLM call (tests); defaults to the Vercel AI SDK wrapper. */
  generate?: GenerateFn
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
  private readonly resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
  private readonly now: () => number
  private readonly generate: GenerateFn

  constructor(deps: ConsensusAgentExecutorDependencies) {
    if (!deps.modelProviderResolver && !deps.modelProvider) {
      throw new Error('ConsensusAgentExecutor requires a modelProviderResolver or a modelProvider')
    }
    this.deps = deps
    this.resolveBlockModel = deps.resolveBlockModel ?? (() => undefined)
    this.now = deps.now ?? (() => Date.now())
    this.generate = deps.generate ?? defaultGenerate
  }

  /** Whether this step should actually run consensus (enabled, ≥2 participants, gate passes). */
  private consensusActive(context: AgentRunContext): boolean {
    const cfg = context.consensus
    if (!cfg || !cfg.enabled) return false
    if (cfg.participants.length < 2) return false
    return decideConsensusMode(context.block.estimate, cfg.gating) === 'consensus'
  }

  private async providerFor(context: AgentRunContext): Promise<ModelProvider> {
    if (this.deps.modelProviderResolver && context.workspaceId) {
      return this.deps.modelProviderResolver.forScope({
        workspaceId: context.workspaceId,
        userId: context.initiatedByUserId,
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
      },
      {
        agentKind: context.agentKind,
        blockModelId: context.block.modelId,
        workspaceId: context.workspaceId,
      },
    )
  }

  /** A participant/synthesizer's ref: its pinned model (degraded for inline) else the base ref. */
  private refForModelId(modelId: string | undefined, base: ModelRef): ModelRef {
    if (modelId) {
      const pinned = this.resolveBlockModel(modelId)
      if (pinned) return inlineModelRef(pinned, base)
    }
    return base
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    if (!this.consensusActive(context)) return this.deps.standard.run(context)
    const cfg = context.consensus!

    const provider = await this.providerFor(context)
    const base = await this.baseRef(context)
    const config = resolveAgentConfig(this.deps.agentRouting, context.agentKind)
    const baseSystem = composeBlockSystemPrompt(
      config.system ?? systemPromptFor(context.agentKind),
      context.block,
    )
    const goalPrompt = userPromptFor(context)

    const participants: ResolvedParticipant[] = cfg.participants.map((p) => {
      const ref = this.refForModelId(p.modelId, base)
      return {
        id: p.id,
        role: p.role,
        ...(p.systemFraming ? { systemFraming: p.systemFraming } : {}),
        model: provider.resolve(ref),
        modelLabel: `${ref.provider}:${ref.model}`,
      }
    })
    const synthRef = this.refForModelId(cfg.synthesizerModelId, base)
    const synthesizer = { model: provider.resolve(synthRef), modelLabel: `${synthRef.provider}:${synthRef.model}` }

    const session: ConsensusSession = {
      id: `cns_${context.executionId ?? 'x'}_${context.stepIndex}`,
      blockId: context.block.id ?? '',
      executionId: context.executionId ?? null,
      stepIndex: context.stepIndex,
      agentKind: context.agentKind,
      strategy: cfg.strategy,
      status: 'running',
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
    this.deps.logger?.info(
      {
        msg: 'consensus.start',
        strategy: cfg.strategy,
        agentKind: context.agentKind,
        participants: participants.length,
        executionId: context.executionId,
        stepIndex: context.stepIndex,
      },
      'consensus session started',
    )

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
      this.deps.logger?.info(
        { msg: 'consensus.done', strategy: cfg.strategy, confidence: result.confidence },
        'consensus session complete',
      )
      return {
        output: result.synthesis,
        model: `consensus:${cfg.strategy}:${synthesizer.modelLabel}`,
        usage: result.usage,
      }
    } catch (error) {
      session.status = 'failed'
      session.error = error instanceof Error ? error.message : String(error)
      session.updatedAt = this.now()
      await this.emit(context, session)
      this.deps.logger?.warn?.({ msg: 'consensus.failed', error: session.error }, 'consensus session failed')
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
    const ref = this.refForModelId(context.consensus!.synthesizerModelId, base)
    return `consensus:${context.consensus!.strategy}:${ref.provider}:${ref.model}`
  }

  isQuotaBased(context: AgentRunContext): Promise<boolean> {
    // Consensus makes metered inline calls; only the delegated path can be quota-based.
    if (this.consensusActive(context)) return Promise.resolve(false)
    return this.deps.standard.isQuotaBased?.(context) ?? Promise.resolve(false)
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

  async stopJob(handle: AgentJobHandle): Promise<void> {
    if (isAsyncAgentExecutor(this.deps.standard) && this.deps.standard.stopJob) {
      await this.deps.standard.stopJob(handle)
    }
  }
}
