import type {
  AgentFailure,
  AgentFailureKind,
  Block,
  BlueprintService,
  CiStatusProvider,
  CloudProvider,
  ExecutionInstance,
  MergeAssessment,
  MergePresetRepository,
  Pipeline,
  PipelineStep,
  PullRequestMerger,
  PullRequestMergeabilityProvider,
  StepReviewComment,
  SubscriptionActivationRepository,
  TicketTrackerProvider,
} from '@cat-factory/kernel'
import {
  parseBlueprintService,
  parseMergeAssessment,
  parseSpecDoc,
  parseCompanionAssessment,
  parseTestReport,
  DEFAULT_COMPANION_MAX_ATTEMPTS,
  type CompanionAssessment,
  type TestReport,
} from '@cat-factory/contracts'
import {
  CODE_AWARE_TRAIT,
  companionFor,
  companionTargets,
  hasTrait,
  isCompanionKind,
} from '@cat-factory/agents'
import { getFragment } from '@cat-factory/prompt-fragments'
import { extractJson } from '../requirements/requirements.logic.js'
import {
  resolveIndividualVendors,
  type HasPersonalSubscription,
} from './individualVendors.logic.js'
import {
  assertFound,
  ConflictError,
  getErrorMessage,
  isModelUsable,
  NotFoundError,
  type ProviderCapabilities,
  sameSubtasks,
  type SubscriptionVendor,
} from '@cat-factory/kernel'
import { DEFAULT_MERGE_PRESET } from '@cat-factory/kernel'
import {
  aggregateCi,
  CI_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  describeFailingChecks,
  isCiGreen,
  MERGER_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  TRACKER_AGENT_KIND,
  ANALYSIS_AGENT_KIND,
  TESTER_AGENT_KIND,
  FIXER_AGENT_KIND,
} from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { LlmObservabilityService } from '../observability/LlmObservabilityService.js'
import type {
  AccountRepository,
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/kernel'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import type { WorkRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import { isDeployStep } from '@cat-factory/integrations'
import { descendantIds, serviceOf } from '../board/board.logic.js'
import type { BoardService } from '../board/BoardService.js'
import type { SpendService } from '@cat-factory/spend'
import { requireWorkspace } from '@cat-factory/kernel'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import { planResumedSteps } from './retry.logic.js'
import {
  isContainerEvictionError,
  isTransientEviction,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
} from './job.logic.js'

/**
 * "What to do next" guidance per failure kind a pipeline run can produce, shown
 * under the failure banner on the board (mirrors bootstrap's FAILURE_HINTS). Only
 * the execution-relevant subset of {@link AgentFailureKind} is keyed.
 */
const EXECUTION_FAILURE_HINTS: Partial<Record<AgentFailureKind, string>> = {
  agent:
    'An agent step failed after its automatic retries. Review the run, then retry to re-run the pipeline.',
  job_failed:
    'The implementation container reported a failure. Inspect its logs (Cloudflare Workers Observability, filtered by the run id), then retry to spin a fresh container.',
  evicted:
    'The implementation container kept vanishing mid-run even after automatic fresh-container restarts. Most often this is transient: a deploy / new-version rollout draining the container, in which case simply retrying once the rollout has finished succeeds. If it persists, it points at a memory or crash issue on the run — inspect its logs (Cloudflare Workers Observability, filtered by the run id) and consider a heavier container instance type. Retry to try again.',
  timeout:
    'The run exceeded its time budget — a step or the implementation job did not finish in time. Retry to start it again.',
  decision_timeout:
    'A required decision was not answered in time, so the run was stopped. Retry to re-run the pipeline.',
  rejected:
    'You rejected this step’s proposal, stopping the run. Retry to re-run the pipeline from the rejected step.',
  companion_rejected:
    'A companion agent kept rating the output below its quality threshold after the automatic rework attempts were spent. Review the companion’s feedback on the run, address it (or lower the threshold in the pipeline), then retry.',
  cancelled: 'You stopped this run; its container was killed. Retry to start it again.',
  unknown: 'The run failed for an unclassified reason. Review the run, then retry.',
}

/**
 * The `revision` slice of an agent context when a step is being re-run with feedback
 * — either a human's "request changes" on its approval gate, or a downstream
 * companion's automatic rework (`step.rework`). The companion path wins when both are
 * present. Empty object when neither applies (no revision context).
 */
function buildRevisionContext(step: PipelineStep): {
  revision?: {
    previousProposal: string
    feedback: string
    comments?: { quotedSource: string; body: string }[]
  }
} {
  const source = step.rework
    ? {
        previousProposal: step.rework.previousProposal,
        feedback: step.rework.feedback,
        comments: step.rework.comments,
      }
    : step.approval?.status === 'changes_requested'
      ? {
          previousProposal: step.approval.proposal,
          feedback: step.approval.feedback ?? '',
          comments: step.approval.comments,
        }
      : undefined
  if (!source) return {}
  return {
    revision: {
      previousProposal: source.previousProposal,
      feedback: source.feedback,
      ...(source.comments?.length
        ? { comments: source.comments.map((c) => ({ quotedSource: c.quotedSource, body: c.body })) }
        : {}),
    },
  }
}

/** Format a 0..1 score as a rounded percentage for notification copy. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

export interface ExecutionServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  /**
   * Resolves the owning account of a workspace so a service that pins no cloud
   * provider falls back to the account's `defaultCloudProvider` at dispatch.
   */
  accountRepository: AccountRepository
  idGenerator: IdGenerator
  clock: Clock
  agentExecutor: AgentExecutor
  workRunner: WorkRunner
  executionEventPublisher: ExecutionEventPublisher
  boardService: BoardService
  spendService: SpendService
  /**
   * Optional: when the document-source integration is configured, documents
   * linked to a block are resolved here and fed to the agent as extra context.
   */
  documentRepository?: DocumentRepository
  /**
   * Optional: when the task-source integration is configured, tracker issues
   * linked to a block are resolved here and fed to the agent as extra context.
   */
  taskRepository?: TaskRepository
  /**
   * Optional: when the requirements-review feature is configured, a block's
   * reworked ("incorporated") requirements are read here. When present they REPLACE
   * the block's description + linked docs/tasks as the agent context (for every
   * step) and become the per-task input the spec-writer aggregates. Absent
   * → the engine uses the original description + docs/tasks unchanged.
   */
  requirementReviewRepository?: RequirementReviewRepository
  /**
   * Optional: when the individual-usage subscription store is configured, a finished
   * run's per-run credential activation is deleted here the moment it reaches a terminal
   * state, bounding standing exposure to the run's own lifetime (the TTL sweep is the
   * backstop). Absent → activations are reclaimed by the TTL sweep alone.
   */
  subscriptionActivationRepository?: SubscriptionActivationRepository
  /**
   * Optional: resolve a workspace's per-agent-kind default model id (the same resolver
   * the container executor uses for dispatch). The personal-credential gate consults it
   * so a run whose block has NO pinned model but whose workspace default resolves to an
   * individual-usage vendor is still gated up-front — matching what dispatch will resolve,
   * instead of starting and then failing on a missing activation. Absent → the gate sees
   * only the block's pinned model (env-routing defaults are operator-level and not gated).
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
  /**
   * Optional: resolve the provider capabilities (configured direct keys +
   * subscription vendors + whether Cloudflare AI is enabled) for a workspace and the
   * run initiator. The start guard uses it to block a pipeline whose steps' canonical
   * models have no usable provider. Absent → the guard is skipped (tests / unconfigured
   * facades), exactly like the existing optional engine deps.
   */
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  /**
   * Optional: when the environment integration is configured, a `deployer` step
   * provisions an ephemeral environment deterministically through this service
   * (no LLM), and downstream steps discover the resulting env via it.
   */
  environmentProvisioning?: EnvironmentProvisioningService
  /**
   * Optional: when the board-scan module is configured, a `blueprints` step's
   * decomposition tree is reconciled onto the board through this (BoardScanService).
   * Absent → a blueprint step still runs and commits its in-repo files, but the
   * board isn't auto-updated from it.
   */
  blueprintReconciler?: BlueprintReconciler
  /**
   * Optional: raises human-actionable notifications (a PR needs a merge decision,
   * a no-merger pipeline finished, CI fixing gave up). Absent → those events still
   * transition the block but no notification surfaces (tests).
   */
  notificationService?: NotificationService
  /**
   * Optional: reads a block's CI check runs so the `ci` step can gate the PR on
   * green CI. Absent → the `ci` step is a pass-through (nothing to gate), so the
   * engine works unchanged when GitHub CI isn't wired.
   */
  ciStatusProvider?: CiStatusProvider
  /**
   * Optional: reads a block's PR mergeability so the `conflicts` step can gate the
   * PR on being mergeable. Absent → the `conflicts` step is a pass-through (nothing
   * to gate), so the engine works unchanged when GitHub isn't wired.
   */
  mergeabilityProvider?: PullRequestMergeabilityProvider
  /**
   * Optional: performs the real GitHub merge when a task should become `done`.
   * Absent → `done` is a board-only flip (tests); when wired, `done` provably
   * means the PR was merged on the remote.
   */
  pullRequestMerger?: PullRequestMerger
  /**
   * Optional: resolves a task's merge threshold preset (auto-merge ceilings + the
   * CI-fixer attempt budget). Absent → the built-in {@link DEFAULT_MERGE_PRESET}.
   */
  mergePresetRepository?: MergePresetRepository
  /**
   * Optional: files a GitHub issue / Jira ticket for the `tracker` step (the
   * tech-debt recurring pipeline). Absent → the `tracker` step passes through
   * without filing anything, so the engine works unchanged when no tracker is wired.
   */
  ticketTrackerProvider?: TicketTrackerProvider
  /**
   * Optional: the LLM observability sink. When wired, each emit rolls the per-run
   * model-call aggregates onto the matching pipeline steps (`step.metrics`) so the
   * board shows tokens / output-limit headroom / transport-vs-execution latency
   * live. Absent (tests / unconfigured) → steps carry no `metrics`.
   */
  llmObservability?: LlmObservabilityService
}

/** Reconciles a Blueprinter step's tree onto the board in place (BoardScanService). */
export interface BlueprintReconciler {
  reconcileBlueprint(
    workspaceId: string,
    frameId: string | null,
    service: BlueprintService,
  ): Promise<unknown>
}

/**
 * The execution engine. It orchestrates a pipeline of agent-performed steps and
 * is fully deterministic: `advanceInstance` moves one run forward by exactly one
 * step, delegating the actual work — and the choice of whether to pause for a
 * human decision — to the injected {@link AgentExecutor}. The durable workflow
 * driver calls it in a loop. All LLM behaviour lives behind that port, so the
 * engine here can be tested with a
 * deterministic fake and no timing/delays.
 */
export class ExecutionService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly executionRepository: ExecutionRepository
  private readonly accountRepository: AccountRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly agentExecutor: AgentExecutor
  private readonly workRunner: WorkRunner
  private readonly events: ExecutionEventPublisher
  private readonly board: BoardService
  private readonly spend: SpendService
  private readonly documents?: DocumentRepository
  private readonly tasks?: TaskRepository
  private readonly requirementReviews?: RequirementReviewRepository
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly blueprintReconciler?: BlueprintReconciler
  private readonly notificationService?: NotificationService
  private readonly llmObservability?: LlmObservabilityService
  private readonly ciStatusProvider?: CiStatusProvider
  private readonly mergeabilityProvider?: PullRequestMergeabilityProvider
  private readonly prMerger?: PullRequestMerger
  private readonly mergePresetRepository?: MergePresetRepository
  private readonly ticketTrackerProvider?: TicketTrackerProvider
  private readonly subscriptionActivations?: SubscriptionActivationRepository
  private readonly resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>

  constructor({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    accountRepository,
    idGenerator,
    clock,
    agentExecutor,
    workRunner,
    executionEventPublisher,
    boardService,
    spendService,
    documentRepository,
    taskRepository,
    requirementReviewRepository,
    environmentProvisioning,
    blueprintReconciler,
    notificationService,
    llmObservability,
    ciStatusProvider,
    mergeabilityProvider,
    pullRequestMerger,
    mergePresetRepository,
    ticketTrackerProvider,
    subscriptionActivationRepository,
    resolveWorkspaceModelDefault,
    resolveProviderCapabilities,
  }: ExecutionServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.accountRepository = accountRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.agentExecutor = agentExecutor
    this.workRunner = workRunner
    this.events = executionEventPublisher
    this.board = boardService
    this.spend = spendService
    this.documents = documentRepository
    this.tasks = taskRepository
    this.requirementReviews = requirementReviewRepository
    this.environmentProvisioning = environmentProvisioning
    this.blueprintReconciler = blueprintReconciler
    this.notificationService = notificationService
    this.llmObservability = llmObservability
    this.ciStatusProvider = ciStatusProvider
    this.mergeabilityProvider = mergeabilityProvider
    this.prMerger = pullRequestMerger
    this.mergePresetRepository = mergePresetRepository
    this.ticketTrackerProvider = ticketTrackerProvider
    this.subscriptionActivations = subscriptionActivationRepository
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
    this.resolveProviderCapabilities = resolveProviderCapabilities
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  private async requireBlock(workspaceId: string, id: string): Promise<Block> {
    return assertFound(await this.blockRepository.get(workspaceId, id), 'Block', id)
  }

  /**
   * The individual-usage subscription vendors a run STARTED against `blockId` with
   * `pipelineId` will lease a personal credential for — so the controller can gate the
   * run on the initiator's personal subscription(s) up-front. Mirrors the dispatch-time
   * model precedence (block pin → workspace per-kind default) across every step, AND the
   * per-user dispatch decision: `hasPersonalSubscription(vendor)` reports whether the
   * initiator has their own subscription for a vendor, so a dual-mode model (GLM) only
   * gates a subscriber (a non-subscriber runs it on the Cloudflare base, ungated).
   * Defaults to "no personal subscription" for system/unauthenticated callers.
   */
  async individualVendorsForBlock(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    hasPersonalSubscription: HasPersonalSubscription = () => false,
  ): Promise<SubscriptionVendor[]> {
    const block = await this.requireBlock(workspaceId, blockId)
    const pipeline = await this.pipelineRepository.get(workspaceId, pipelineId)
    return this.resolveIndividualVendors(
      workspaceId,
      block.modelId,
      pipeline?.agentKinds ?? [],
      hasPersonalSubscription,
    )
  }

  /** The individual-usage vendors a failed run's resumed steps use (for the retry gate). */
  async individualVendorsForRun(
    workspaceId: string,
    executionId: string,
    hasPersonalSubscription: HasPersonalSubscription = () => false,
  ): Promise<SubscriptionVendor[]> {
    const run = await this.executionRepository.get(workspaceId, executionId)
    if (!run) return []
    const block = await this.blockRepository.get(workspaceId, run.blockId)
    if (!block) return []
    return this.resolveIndividualVendors(
      workspaceId,
      block.modelId,
      run.steps.map((s) => s.agentKind),
      hasPersonalSubscription,
    )
  }

  /**
   * The set of individual-usage vendors the given steps resolve to, used to gate a run
   * on the initiator's personal subscription(s) up-front. Delegates to the pure
   * {@link resolveIndividualVendors}, which mirrors the dispatch-time precedence: a
   * resolvable block pin decides the set alone (NONE for a non-subscription model), and
   * only an unpinned run falls to the workspace per-kind defaults.
   */
  private resolveIndividualVendors(
    workspaceId: string,
    blockModelId: string | undefined,
    agentKinds: string[],
    hasPersonalSubscription: HasPersonalSubscription,
  ): Promise<SubscriptionVendor[]> {
    const resolveDefault = this.resolveWorkspaceModelDefault
    return resolveIndividualVendors(
      blockModelId,
      agentKinds,
      resolveDefault ? (kind) => resolveDefault(workspaceId, kind) : undefined,
      hasPersonalSubscription,
    )
  }

  /**
   * Guard a Tester pipeline's start: local-mode testing must have its infra
   * configured on the service frame — either a docker-compose path to stand the
   * dependencies up, or the explicit "no infra dependencies" flag. Ephemeral-mode
   * testing uses the provisioned environment, so it needs neither. Throws a
   * {@link ConflictError} (surfaced as an actionable message) when neither is set.
   */
  private async assertTesterInfraConfigured(workspaceId: string, block: Block): Promise<void> {
    // The local-infra requirement applies only when the Tester runs in LOCAL mode.
    // Ephemeral is the default, so an unset choice needs no service infra config.
    if (block.agentConfig?.['tester.environment'] !== 'local') return
    const service = await this.resolveServiceConfig(workspaceId, block)
    if (service?.noInfraDependencies || service?.testComposePath) return
    throw new ConflictError(
      "This task's pipeline runs the Tester locally, but its service has no test infra " +
        "configured. Set the service's docker-compose path, or mark it as having no infra " +
        'dependencies, before starting — or switch the Tester to the ephemeral environment.',
    )
  }

  /**
   * Guard a pipeline's start on having a usable provider for every step's canonical
   * model. The model a step runs is resolved by the same precedence the dispatch path
   * uses (block pin → workspace per-kind default); each canonical id must have a usable
   * provider given what's configured — a direct API key for its provider, a connected
   * subscription vendor, or the opt-in Cloudflare lib enabled. Env-routing defaults (the
   * last fallback, with no catalog id) are operator-level and not gated, matching the
   * personal-credential gate. A throw aborts the start cleanly before any side effects.
   * Skipped when no capability resolver is wired (tests / unconfigured facades).
   */
  private async assertProvidersConfiguredForPipeline(
    workspaceId: string,
    block: Block,
    pipeline: Pipeline,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    if (!this.resolveProviderCapabilities) return
    const caps = await this.resolveProviderCapabilities(workspaceId, initiatedBy)
    const unconfigured = new Set<string>()
    const check = (id: string | undefined): void => {
      if (id && !isModelUsable(id, caps)) unconfigured.add(id)
    }
    if (block.modelId) {
      // A block-level pin applies to every step.
      check(block.modelId)
    } else if (this.resolveWorkspaceModelDefault) {
      for (const kind of pipeline.agentKinds) {
        check(await this.resolveWorkspaceModelDefault(workspaceId, kind))
      }
    }
    if (unconfigured.size > 0) {
      throw new ConflictError(
        `This pipeline uses models with no configured provider: ${[...unconfigured].join(', ')}. ` +
          'Add an API key for the provider, connect a subscription, or enable Cloudflare AI ' +
          'before starting.',
      )
    }
  }

  /** Start a pipeline against a block, replacing any prior run on it. */
  async start(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    /**
     * Internal user id of the initiator. Recorded on the run so an individual-usage
     * model (Claude) uses this user's OWN personal subscription. Absent for
     * system-initiated runs (recurring schedules) and auth-disabled dev.
     */
    initiatedBy?: string | null,
    /**
     * Mint the per-run personal-credential activation for an individual-usage model.
     * Invoked with the new run's id BEFORE it is persisted/dispatched, so the async
     * steps can lease it; a throw (wrong/missing password) aborts the start cleanly
     * with nothing persisted. The server layer supplies this (the personal store lives
     * outside the domain Core); absent for non-individual runs.
     */
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, blockId)
    const pipeline = assertFound(
      await this.pipelineRepository.get(workspaceId, pipelineId),
      'Pipeline',
      pipelineId,
    )

    // A pipeline with a Tester that runs locally needs the service's test infra
    // configured (a docker-compose path, or an explicit "no infra dependencies"
    // flag). Block the start with a clear, actionable error otherwise — before any
    // side effects (activation mint / prior-run teardown).
    if (pipeline.agentKinds.includes(TESTER_AGENT_KIND)) {
      await this.assertTesterInfraConfigured(workspaceId, block)
    }

    // Block the start when a step's canonical model has no usable provider (no direct
    // key, no subscription, no Cloudflare) — before any side effects.
    await this.assertProvidersConfiguredForPipeline(workspaceId, block, pipeline, initiatedBy)

    // Mint the activation next: if the credential can't be unlocked, fail before
    // tearing down the block's prior run or creating a new one.
    const executionId = this.idGenerator.next('exec')
    await activate?.(executionId)

    // Replacing the block's prior run: clear its per-run activation now (it never reaches
    // the terminal cleanup in emitInstance when it's still running), so a replaced run's
    // system-encrypted token copy doesn't linger to its TTL. Keyed by the OLD run id, so
    // the activation just minted for the new run is untouched.
    if (this.subscriptionActivations) {
      const prior = await this.executionRepository.getByBlock(workspaceId, blockId)
      if (prior && prior.id !== executionId) {
        await this.subscriptionActivations.deleteByExecution(prior.id)
      }
    }

    await this.executionRepository.deleteByBlock(workspaceId, blockId)

    const steps: PipelineStep[] = pipeline.agentKinds.map((kind, i) => {
      const companionDef = companionFor(kind)
      return {
        agentKind: kind,
        state: i === 0 ? 'working' : 'pending',
        progress: 0,
        decision: null,
        // A gated step pauses for human approval once its proposal is ready (see
        // recordStepResult). Copied from the pipeline definition at run start.
        requiresApproval: pipeline.gates?.[i] ?? false,
        approval: null,
        // A companion step carries its quality bar + rework budget, seeded from the
        // pipeline's per-step threshold (else the companion's default).
        ...(companionDef
          ? {
              companion: {
                threshold: pipeline.thresholds?.[i] ?? companionDef.defaultThreshold,
                maxAttempts: DEFAULT_COMPANION_MAX_ATTEMPTS,
                attempts: 0,
                verdicts: [],
              },
            }
          : {}),
      }
    })
    const instance: ExecutionInstance = {
      id: executionId,
      blockId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      steps,
      currentStep: 0,
      status: 'running',
      initiatedBy: initiatedBy ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'in_progress',
      progress: 0,
      executionId: instance.id,
    })
    // Hand the run off to the durable runner so it progresses server-side without
    // a browser open. With the no-op runner (tests) this does nothing and the run
    // is advanced directly via advanceInstance.
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Advance a single run by exactly one step and report what happened. This is
   * the durable driver's entry point: it reloads the run from storage (so it is
   * safe under replay/retry), no-ops unless the run is actively running, and
   * otherwise performs one agent step via the shared {@link stepInstance} logic.
   */
  async advanceInstance(
    workspaceId: string,
    executionId: string,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    // A paused run is still drivable: the spend gate in stepInstance resumes it
    // once the budget frees up (or re-pauses it otherwise).
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    return this.stepInstance(workspaceId, instance, options)
  }

  /** Advance a single running instance by one step, persisting the result. */
  private async stepInstance(
    workspaceId: string,
    instance: ExecutionInstance,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }

    // Spend gate: don't incur monetary LLM cost once the budget is exhausted. Pause
    // the run (so the frontend can flag it) and stop here. A previously-paused run
    // that finds the budget has freed up resumes and proceeds. EXEMPTION: a step that
    // runs on a flat-rate subscription (quota) model — Claude Code / Codex on a pooled
    // token — incurs no metered monetary cost and never contributes to the budget, so
    // it must not be held hostage by a budget other (metered) models exhausted.
    if (await this.spend.isOverBudget()) {
      if (!(await this.currentStepIsQuotaBased(workspaceId, instance, step))) {
        if (instance.status !== 'paused') {
          instance.status = 'paused'
          await this.executionRepository.upsert(workspaceId, instance)
          await this.emitInstance(workspaceId, instance)
        }
        return { kind: 'paused' }
      }
    }
    if (instance.status === 'paused') instance.status = 'running'

    if (step.state === 'waiting_decision') {
      // Parked on either an agent-raised decision or a human approval gate; both
      // are addressed by the same durable event id.
      const pendingId = step.decision?.id ?? step.approval?.id
      if (pendingId) {
        instance.status = 'blocked'
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
        return { kind: 'awaiting_decision', decisionId: pendingId }
      }
    }
    this.startStep(step)

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1

    // A `deployer` step provisions an ephemeral environment deterministically via
    // the provider — no LLM, no token usage — when the integration is wired.
    // Otherwise it falls through to the normal agent path.
    if (this.environmentProvisioning && isDeployStep(step.agentKind)) {
      const result = await this.runDeployer(workspaceId, instance, block, options)
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
    }

    // A `tracker` step files a GitHub issue / Jira ticket from the preceding
    // `analysis` output (the tech-debt pipeline) — no LLM of its own. It is a
    // pass-through when no tracker provider is wired or none is configured for the
    // workspace. See {@link runTracker}.
    if (step.agentKind === TRACKER_AGENT_KIND) {
      const result = await this.runTracker(workspaceId, instance, block)
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
    }

    // A `ci` step gates the PR on green CI: it polls GitHub check runs and, on
    // failure, dispatches the `ci-fixer` container agent — no LLM of its own. It
    // is a pass-through when no CI status provider is wired (the engine works
    // unchanged without GitHub CI). See {@link evaluateCi}.
    if (step.agentKind === CI_AGENT_KIND) {
      return this.evaluateCi(workspaceId, instance, step, block, isFinalStep)
    }

    // A `conflicts` step gates the PR on being mergeable: it checks the PR's
    // mergeability and, on a conflict, dispatches the `conflict-resolver` container
    // agent — no LLM of its own. Pass-through when no mergeability provider is wired.
    // See {@link evaluateConflicts}.
    if (step.agentKind === CONFLICTS_AGENT_KIND) {
      return this.evaluateConflicts(workspaceId, instance, step, block, isFinalStep)
    }

    // A companion step grades the nearest preceding producer of one of its target
    // kinds, looping it back for automatic rework below the threshold (and failing
    // the run once the budget is spent) before any human gate. See evaluateCompanion.
    if (isCompanionKind(step.agentKind)) {
      return this.evaluateCompanion(workspaceId, instance, step, block, isFinalStep, options)
    }

    // Async (container) steps don't block: dispatch the job and park. The durable
    // driver polls `pollAgentJob` between sleeps so the run can span far longer
    // than a single durable step's timeout, while each step stays short. A set
    // `jobId` means a prior (possibly replayed) dispatch already started the job,
    // so we re-attach instead of starting a duplicate.
    const context = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const executor = this.agentExecutor
    if (isAsyncAgentExecutor(executor) && executor.runsAsync(context)) {
      if (!step.jobId) {
        // The model is fixed the moment its ref resolves (block pin > workspace
        // default > env routing) — long before the container is up — so name it on
        // the very first "spinning up container" emit instead of waiting for the
        // dispatch to return. startJob confirms the same value below.
        const previewModel = await this.previewStepModel(context)
        if (previewModel) step.model = previewModel
        // Surface an explicit "spinning up container" phase for the cold-boot
        // window: dispatch blocks until the per-run container is up and has
        // accepted the job, so emitting before it lets the board show the boot
        // instead of a blank "working" state.
        step.startingContainer = true
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)

        const handle = await executor.startJob(context)
        step.jobId = handle.jobId
        // Record the model at dispatch — the poll site can't resolve it later.
        if (handle.model) step.model = handle.model
        // The dispatch returned, so the container is up and execution has begun.
        step.startingContainer = false
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // Inline path: the model is resolved before the (blocking) LLM call, so surface
    // it now — the board names the model while the step is querying instead of only
    // once the result lands. recordStepResult re-asserts it from the result.
    const previewModel = await this.previewStepModel(context)
    if (previewModel && previewModel !== step.model) {
      step.model = previewModel
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
    }

    const result = await this.runAgent(context, options)
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
  }

  /**
   * Preview the model a step will run (`provider:model`) ahead of the work, so the
   * board can show it during the inline query / container cold-boot rather than only
   * once the result or job handle lands. Best-effort: the executor may not implement
   * a preview, and a resolution failure (e.g. an unwired container kind that fails at
   * dispatch anyway) must never break the run — both yield undefined.
   */
  private async previewStepModel(context: AgentRunContext): Promise<string | undefined> {
    if (!this.agentExecutor.resolveModel) return undefined
    try {
      return await this.agentExecutor.resolveModel(context)
    } catch {
      return undefined
    }
  }

  /**
   * Whether the current step will run on a flat-rate subscription (quota) model, so
   * the spend gate can let it proceed even when the monetary budget is exhausted.
   * Resolved through the executor (the authority on the "subscriptions always win"
   * routing) off a full step context. Best-effort and side-effect-free: an executor
   * without the capability, a missing block, or any resolution error all report false
   * (the step is treated as budget-metered, the prior behaviour). Only consulted on
   * the over-budget path, so the extra context build never touches the happy path.
   */
  private async currentStepIsQuotaBased(
    workspaceId: string,
    instance: ExecutionInstance,
    step: ExecutionInstance['steps'][number],
  ): Promise<boolean> {
    if (!this.agentExecutor.isQuotaBased) return false
    try {
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      if (!block) return false
      const isFinalStep = instance.currentStep === instance.steps.length - 1
      const context = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
      return await this.agentExecutor.isQuotaBased(context)
    } catch {
      return false
    }
  }

  /**
   * Poll the asynchronous job a parked step dispatched. Returns `awaiting_job`
   * while it runs (the driver keeps polling), records the result and advances on
   * success, or reports `job_failed` so the driver can fail the run. Reading run
   * state from storage on every call keeps it safe under Workflows replay/retry:
   * once a job's result is recorded the step's `jobId` is cleared, so a re-poll
   * simply lets the driver advance the now-current step.
   */
  async pollAgentJob(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }
    // No job in flight: a prior poll already recorded it (and advanced). Let the
    // driver loop and advance whatever step is now current.
    if (!step.jobId) return { kind: 'continue' }

    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) return { kind: 'noop' }

    const update = await executor.pollJob({ jobId: step.jobId, workspaceId })
    if (update.state === 'running') {
      // A successful poll proves the container is up, so the cold-boot phase is
      // over (defensive: a replay may have left the flag set). Surface live subtask
      // progress (e.g. 3/8 todos done) without advancing the step. Only persist +
      // emit when something actually changed so an idle poll doesn't churn storage
      // or the event stream.
      let changed = false
      if (step.startingContainer) {
        step.startingContainer = false
        changed = true
      }
      if (update.subtasks && !sameSubtasks(step.subtasks, update.subtasks)) {
        step.subtasks = update.subtasks
        step.progress =
          update.subtasks.total > 0 ? update.subtasks.completed / update.subtasks.total : 0
        changed = true
      }
      if (changed) {
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // A `ci` step's in-flight job is a CI-fixer run, NOT the step's own work: when
    // it finishes (or fails) we don't record a result or advance — we drop the
    // handle, return the gate to `checking`, and re-poll CI (the fixer's push
    // triggers a fresh run). A fixer that failed without pushing leaves CI red, so
    // the next CI check re-dispatches (until the attempt budget is spent).
    if (step.agentKind === CI_AGENT_KIND) {
      step.jobId = undefined
      step.subtasks = undefined
      if (step.ci) step.ci.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_ci', stepIndex: instance.currentStep }
    }

    // A `conflicts` step's in-flight job is a conflict-resolver run, NOT the step's
    // own work: when it finishes (or fails) we drop the handle, return the gate to
    // `checking` and re-check mergeability (the resolver's push updates it). A
    // resolver that failed without pushing leaves the PR conflicted, so the next
    // check re-dispatches (until the attempt budget is spent).
    if (step.agentKind === CONFLICTS_AGENT_KIND) {
      step.jobId = undefined
      step.subtasks = undefined
      if (step.conflicts) step.conflicts.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_conflicts', stepIndex: instance.currentStep }
    }

    // A `tester` step in its `fixing` phase has a Fixer job in flight, NOT the
    // step's own work: when it finishes (or fails) we drop the handle, return to
    // `testing`, and re-dispatch the Tester against the (now-fixed) branch — its
    // fresh report then drives greenlight-or-loop again. Mirrors the CI gate.
    if (step.agentKind === TESTER_AGENT_KIND && step.test?.phase === 'fixing') {
      step.jobId = undefined
      step.subtasks = undefined
      step.test.phase = 'testing'
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      if (!block) return { kind: 'noop' }
      // Reclaim the finished Fixer container before re-dispatching the Tester so it
      // boots fresh against the just-pushed fixes (rather than re-attaching to the
      // completed job by run id).
      await this.stopRunContainer(workspaceId, instance.id)
      return this.dispatchTester(workspaceId, instance, step, block)
    }

    if (update.state === 'failed') {
      // A container eviction (the per-run container vanished, its in-memory job is
      // gone) is usually transient. Recover it by dropping the dead handle and
      // returning `continue`: the driver loops back into `advanceInstance`, which
      // re-dispatches the SAME step to a fresh container (a new instance boots under
      // the same id). Two flavours, with separate budgets:
      //   - one the runtime facade flagged as transient infra churn (e.g. a deploy
      //     draining the sandbox) is not a sick run, and can recur several times in a
      //     short window, so it gets the larger MAX_TRANSIENT_EVICTION_RECOVERIES
      //     budget (recoveries are naturally spaced by the job poll interval, riding
      //     out the window);
      //   - any other eviction (crash/OOM) gets the tight MAX_EVICTION_RECOVERIES.
      // Once a budget is spent the eviction is treated as deterministic and fails the
      // run as `evicted`. A genuine agent/job failure is never recovered.
      if (isContainerEvictionError(update.error)) {
        const transient = isTransientEviction(update.error)
        const limit = transient ? MAX_TRANSIENT_EVICTION_RECOVERIES : MAX_EVICTION_RECOVERIES
        const recoveries = transient
          ? (step.transientEvictionRecoveries ?? 0)
          : (step.evictionRecoveries ?? 0)
        if (recoveries < limit) {
          if (transient) step.transientEvictionRecoveries = recoveries + 1
          else step.evictionRecoveries = recoveries + 1
          step.jobId = undefined
          step.subtasks = undefined
          step.progress = 0
          await this.executionRepository.upsert(workspaceId, instance)
          await this.emitInstance(workspaceId, instance)
          return { kind: 'continue' }
        }
        return {
          kind: 'job_evicted',
          error: transient
            ? `${update.error} (still evicting after ${recoveries} automatic restarts through the infrastructure churn — treating as deterministic)`
            : `${update.error ?? 'Container evicted'} (still evicting after ${recoveries} automatic container restart${recoveries === 1 ? '' : 's'} — treating as deterministic)`,
        }
      }
      return { kind: 'job_failed', error: update.error }
    }

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Clear the handle before recording so a replay re-attaches to nothing.
    step.jobId = undefined
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, update.result)
  }

  /**
   * Re-check a `ci` step's gate from the durable driver's `awaiting_ci` loop:
   * re-reads CI check runs and returns the same outcomes as the initial evaluation
   * (green → advance, still running → keep polling, failure → dispatch a fixer or
   * give up). Safe under replay: reading run state fresh each call. A no-op unless
   * the current step is a `ci` step actively in its `checking` phase.
   */
  async pollCi(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    if (!step || step.agentKind !== CI_AGENT_KIND) return { kind: 'continue' }
    // A fixer job is in flight — the driver should be polling it, not CI; let the
    // job-poll loop drive (defensive; a replay could route here).
    if (step.jobId)
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    return this.evaluateCi(workspaceId, instance, step, block, isFinalStep)
  }

  /**
   * Re-check a `conflicts` step's gate from the durable driver's `awaiting_conflicts`
   * loop: re-reads the PR's mergeability and returns the same outcomes as the initial
   * evaluation (mergeable → advance, still computing → keep polling, conflicted →
   * dispatch a resolver or give up). Safe under replay; a no-op unless the current
   * step is a `conflicts` step actively in its `checking` phase.
   */
  async pollConflicts(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    if (!step || step.agentKind !== CONFLICTS_AGENT_KIND) return { kind: 'continue' }
    // A resolver job is in flight — the driver should be polling it, not mergeability.
    if (step.jobId)
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    return this.evaluateConflicts(workspaceId, instance, step, block, isFinalStep)
  }

  /**
   * Transition a step into `working`, stamping its start time the first time it
   * actually begins. Set-once so a Workflows replay (which re-runs `advance`)
   * preserves the original start rather than resetting it on every replay. An
   * explicit re-run clears `startedAt` first (see {@link requestStepChanges}) so
   * the fresh attempt is timed from scratch.
   */
  private startStep(step: PipelineStep): void {
    step.state = 'working'
    if (step.startedAt == null) step.startedAt = this.clock.now()
  }

  /**
   * Transition a step into `done`, stamping its finish time once. Set-once so the
   * approval-gate flow (which re-asserts `done` after a human approves, long after
   * the agent actually finished) keeps the agent's true completion time, and so a
   * replay doesn't move it. With {@link startStep}'s `startedAt` this yields the
   * step's execution duration.
   */
  private finishStep(step: PipelineStep): void {
    step.state = 'done'
    if (step.finishedAt == null) step.finishedAt = this.clock.now()
  }

  /**
   * Record a completed agent step's result and report what the driver should do
   * next: meter token usage, park on a raised decision, or persist the output
   * (and any opened PR) and either finish the run or advance to the next step.
   * Shared by the inline path and the async-job poll path.
   */
  private async recordStepResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ): Promise<AdvanceResult> {
    // Meter the LLM call against the spend budget. Recorded whether the step
    // completed or raised a decision — both consumed tokens.
    if (result.usage) {
      await this.spend.record({
        workspaceId,
        executionId: instance.id,
        agentKind: step.agentKind,
        model: result.model ?? 'unknown',
        usage: result.usage,
      })
    }

    // The agent asked for a human decision and this step hasn't resolved one yet.
    if (result.decision && !step.decision?.chosen) {
      step.decision = {
        id: this.idGenerator.next('dec'),
        question: result.decision.question,
        options: [...result.decision.options],
        chosen: null,
      }
      step.state = 'waiting_decision'
      instance.status = 'blocked'
      await this.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.decision.id }
    }

    // A `tester` step returned a structured report. On a withheld greenlight we do
    // NOT finish the step: we loop the `fixer` (within the attempt budget) and
    // re-test, mirroring the CI gate. A greenlight (or no provider) falls through to
    // the normal finish/advance below. Records the report on the step either way.
    if (step.agentKind === TESTER_AGENT_KIND && result.testReport !== undefined) {
      const looped = await this.resolveTesterResult(workspaceId, instance, step, result)
      if (looped) return looped
    }

    // The step completed.
    step.output = result.output ?? ''
    if (result.model) step.model = result.model
    step.progress = 1
    this.finishStep(step)
    // Live subtask counts only describe an in-flight run; drop them now the step
    // is done so the board doesn't show a stale "3/8" against a finished step.
    step.subtasks = undefined
    // A companion-driven rework was just consumed by this re-run; clear it so a later
    // unrelated re-run doesn't re-apply stale feedback (the companion sets fresh
    // feedback if it still rejects the new output).
    step.rework = undefined

    // A repo-operating step (the container "implementer" agent) opened a PR for
    // its work. Record it on the block so the board can surface and link to it,
    // regardless of whether this is the final step.
    if (result.pullRequest) {
      await this.blockRepository.update(workspaceId, instance.blockId, {
        pullRequest: result.pullRequest,
      })
    }

    // A Blueprinter step produced a fresh service decomposition. Validate it with
    // the authoritative schema (a bad payload must never touch the board), then
    // reconcile it in place onto the run's service frame.
    if (result.blueprintService !== undefined) {
      await this.ingestBlueprint(workspaceId, instance.blockId, result.blueprintService)
    }

    // A spec-writer step produced the service's unified specification (`spec.json`)
    // and committed it to the implementation branch. Strict-validate it (a bad payload
    // must never be trusted), then nudge clients to refresh.
    if (result.spec !== undefined) {
      await this.ingestSpec(workspaceId, result.spec)
    }

    // Human approval gate: a step the pipeline marked `requiresApproval` pauses
    // here once its proposal is ready, so a human can review (and edit) it before
    // the next step runs. We reuse the durable decision wait — returning
    // `awaiting_decision` keyed by the approval id parks the run on the same named
    // event the workflow already listens for; `approveStep` / `requestStepChanges`
    // wake it. Never gates the final step (nothing downstream to feed) and is
    // idempotent: an already-approved step falls through to advance/finish.
    if (step.requiresApproval && !isFinalStep && step.approval?.status !== 'approved') {
      step.approval = {
        id: this.idGenerator.next('appr'),
        status: 'pending',
        proposal: step.output,
      }
      step.state = 'waiting_decision'
      instance.status = 'blocked'
      await this.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.approval.id }
    }

    if (isFinalStep) {
      instance.status = 'done'
      // Record the reported confidence for transparency BEFORE any merge — once a
      // task auto-merges it is `done` and `finalizeBlock` early-returns, so this is
      // the single place confidence is persisted across both the merge and review paths.
      if (result.confidence !== undefined) {
        await this.blockRepository.update(workspaceId, instance.blockId, {
          confidence: result.confidence,
        })
      }
      // A `merger` step produced a PR assessment: compare it against the task's
      // thresholds and either merge for real or raise a review notification. This
      // owns the block's terminal status, so `finalizeBlock` then leaves it alone.
      if (result.mergeAssessment !== undefined) {
        await this.resolveMergerStep(workspaceId, instance, result.mergeAssessment)
      }
      await this.finalizeBlock(workspaceId, instance, result.confidence)
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      // The run is finished: reclaim its per-run container now instead of letting it
      // idle out its sleepAfter window (~10 min of billed-but-useless compute). All
      // pipeline steps share the one container keyed by the execution id, so this is
      // only safe on the FINAL step — never between steps. Best-effort/idempotent.
      await this.stopRunContainer(workspaceId, instance.id)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.startStep(next)
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Run a companion step: an inline LLM that grades the nearest preceding producer
   * of one of its target kinds, returning an overall quality rating (0..1) + prose
   * feedback. The rating is compared to the step's threshold:
   *   - at/above  → the companion finishes; if it is itself gated it raises the human
   *                 approval gate on the producer's output, else the run advances.
   *   - below, budget left → the producer is re-run with the companion's feedback
   *                 folded in (the automatic analogue of "request changes").
   *   - below, budget spent → the run fails (`companion_rejected`) for a human.
   * The companion's own JSON output is parsed as the assessment; a malformed payload
   * is treated as a pass (a broken critic must never wedge a run).
   */
  private async evaluateCompanion(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    options: AdvanceOptions,
  ): Promise<AdvanceResult> {
    const targets = companionTargets(step.agentKind)
    // The nearest earlier step whose kind this companion reviews (the producer).
    let producerIndex = -1
    for (let i = instance.currentStep - 1; i >= 0; i--) {
      if (targets.includes(instance.steps[i]!.agentKind)) {
        producerIndex = i
        break
      }
    }

    // Run the companion as a normal inline LLM step: its prompt asks for the rating
    // JSON and `priorOutputs` already carries the producer's output for it to grade.
    const context = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const previewModel = await this.previewStepModel(context)
    if (previewModel && previewModel !== step.model) step.model = previewModel
    const result = await this.runAgent(context, options)
    if (result.usage) {
      await this.spend.record({
        workspaceId,
        executionId: instance.id,
        agentKind: step.agentKind,
        model: result.model ?? 'unknown',
        usage: result.usage,
      })
    }
    if (result.model) step.model = result.model

    const companion = step.companion ?? {
      threshold: companionFor(step.agentKind)?.defaultThreshold ?? 0.8,
      maxAttempts: DEFAULT_COMPANION_MAX_ATTEMPTS,
      attempts: 0,
      verdicts: [],
    }
    let assessment: CompanionAssessment | undefined
    try {
      assessment = parseCompanionAssessment(extractJson(result.output ?? ''))
    } catch {
      assessment = undefined
    }
    // A broken critic (no producer to grade, or an unparseable verdict) passes through
    // rather than wedging the run: record a perfect score and advance.
    const rating = assessment && producerIndex >= 0 ? assessment.rating : 1
    const feedback = assessment?.summary ?? ''
    // Append this cycle's standardized verdict (the same shape the requirements-rework
    // gate stores) so the whole correction sequence is visible, not just the latest.
    companion.verdicts.push({
      rating,
      threshold: companion.threshold,
      passed: rating >= companion.threshold,
      feedback,
    })
    step.companion = companion
    step.output = feedback || result.output || ''

    // PASS: the producer cleared the bar.
    if (rating >= companion.threshold) {
      this.finishStep(step)
      step.progress = 1
      // A gated companion now raises the HUMAN approval gate on the producer's output
      // (the human reviews what the companion just cleared). Never on the final step.
      if (step.requiresApproval && !isFinalStep && step.approval?.status !== 'approved') {
        const producer = producerIndex >= 0 ? instance.steps[producerIndex] : undefined
        step.approval = {
          id: this.idGenerator.next('appr'),
          status: 'pending',
          proposal: producer?.output ?? step.output,
        }
        step.state = 'waiting_decision'
        instance.status = 'blocked'
        await this.updateBlockProgress(workspaceId, instance, 'blocked')
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
        return { kind: 'awaiting_decision', decisionId: step.approval.id }
      }
      if (isFinalStep) {
        instance.status = 'done'
        await this.finalizeBlock(workspaceId, instance, undefined)
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
        await this.stopRunContainer(workspaceId, instance.id)
        return { kind: 'done' }
      }
      instance.currentStep += 1
      const next = instance.steps[instance.currentStep]
      if (next) this.startStep(next)
      await this.updateBlockProgress(workspaceId, instance, 'in_progress')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'continue' }
    }

    // BELOW THRESHOLD, automatic budget spent → fail the run for human attention.
    // Only AUTOMATIC reworks count against the budget (`attempts`); human "request
    // changes" cycles on the companion's gate re-run the producer without consuming it.
    if (companion.attempts >= companion.maxAttempts) {
      const detail = assessment?.summary ?? 'No further detail.'
      await this.failRun(
        workspaceId,
        instance.id,
        `Companion "${step.agentKind}" rated the output ${(rating * 100).toFixed(0)}% ` +
          `(below the ${(companion.threshold * 100).toFixed(0)}% bar) after ` +
          `${companion.attempts} automatic rework attempt(s).`,
        'companion_rejected',
        detail,
      )
      return { kind: 'job_failed', error: 'companion_rejected' }
    }

    // BELOW THRESHOLD, budget left → loop the producer back with the feedback folded
    // in (the automatic analogue of a human "request changes"). `producerIndex` is
    // guaranteed >= 0 here (rating < threshold only when a producer was found and the
    // verdict parsed; otherwise rating defaulted to 1 and we passed above).
    companion.attempts += 1
    const producer = instance.steps[producerIndex]!
    const previousProposal = producer.output ?? ''
    this.rerunProducerThrough(instance, producerIndex, instance.currentStep, {
      previousProposal,
      feedback: assessment?.summary ?? '',
      ...(assessment?.comments?.length ? { comments: assessment.comments } : {}),
    })
    if (instance.status === 'blocked') instance.status = 'running'
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Reset a step so the durable driver re-runs it from scratch: clear its live
   * container job handle (so it dispatches FRESH work rather than re-attaching to a
   * finished or evicted job), its timings, approval gate, live subtasks and last
   * output, and drop it back to `pending`. Preserves the step's identity
   * (`agentKind` / `requiresApproval`) and any companion budget/verdict history.
   */
  private resetStepForRerun(step: PipelineStep): void {
    step.state = 'pending'
    step.startedAt = null
    step.finishedAt = null
    step.jobId = undefined
    step.approval = null
    step.subtasks = undefined
    step.progress = 0
    step.output = undefined
    step.rework = undefined
  }

  /**
   * Loop a producer step back for rework and re-run every step from it up to and
   * including the companion at `companionIndex`: each one is reset (crucially clearing
   * stale container job handles so an intermediate container step re-dispatches fresh
   * work instead of re-attaching to its evicted job), the producer is handed the
   * `rework` feedback + started, and the instance cursor is moved back to the producer.
   * Shared by the automatic companion loop and the human "request changes" path.
   */
  private rerunProducerThrough(
    instance: ExecutionInstance,
    producerIndex: number,
    companionIndex: number,
    rework: NonNullable<PipelineStep['rework']>,
  ): void {
    for (let i = producerIndex; i <= companionIndex; i++) {
      this.resetStepForRerun(instance.steps[i]!)
    }
    const producer = instance.steps[producerIndex]!
    producer.rework = rework
    this.startStep(producer)
    instance.currentStep = producerIndex
  }

  /**
   * Deterministically provision an ephemeral environment for a deployer step.
   * Produces a human-readable summary as the step output and reports no token
   * usage (it incurs no LLM cost). Errors are swallowed into the output unless
   * the durable driver wants them surfaced for its per-step retry.
   */
  private async runDeployer(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    options: AdvanceOptions = {},
  ): Promise<AgentRunResult> {
    try {
      const handle = await this.environmentProvisioning!.provision({
        workspaceId,
        blockId: block.id,
        executionId: instance.id,
        inputs: this.deployInputs(block),
      })
      const lines = [
        `Provisioned ephemeral environment via '${handle.providerId}'.`,
        `Status: ${handle.status}`,
        `URL: ${handle.url ?? '(pending)'}`,
      ]
      if (handle.expiresAt) lines.push(`Expires: ${new Date(handle.expiresAt).toISOString()}`)
      return { output: lines.join('\n'), model: `environment:${handle.providerId}` }
    } catch (error) {
      if (options.rethrowAgentErrors) throw error
      return {
        output: `Deployer error: ${getErrorMessage(error)}`,
      }
    }
  }

  /**
   * File a tracking issue/ticket for a `tracker` step from the preceding `analysis`
   * output. Non-LLM and best-effort: when no provider is wired or none is configured
   * for the workspace it simply notes the skip; a filing error is folded into the
   * step output rather than failing the run (the implementation still proceeds).
   */
  private async runTracker(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<AgentRunResult> {
    if (!this.ticketTrackerProvider) {
      return { output: 'No issue tracker configured; skipped ticket creation.' }
    }
    // The report to file is the closest preceding `analysis` output, falling back
    // to the block description when the pipeline has no analysis step.
    const analysis = instance.steps
      .slice(0, instance.currentStep)
      .filter((s) => s.agentKind === ANALYSIS_AGENT_KIND && s.output)
      .map((s) => s.output as string)
      .pop()
    const body = (analysis ?? block.description ?? '').trim() || 'Automated tech-debt remediation.'
    const frameId = (await this.resolveServiceFrameId(workspaceId, block.id)) ?? block.id
    try {
      const ticket = await this.ticketTrackerProvider.createTicket({
        workspaceId,
        frameId,
        title: `Tech debt: ${block.title}`,
        body,
      })
      if (!ticket) {
        return { output: 'No issue tracker configured; skipped ticket creation.' }
      }
      return { output: `Filed tracking ticket ${ticket.externalId}: ${ticket.url}` }
    } catch (error) {
      return { output: `Could not file a tracking ticket: ${getErrorMessage(error)}` }
    }
  }

  /**
   * Evaluate a `ci` step's gate once: read the PR's CI check runs and decide.
   *   - no provider wired → pass-through (advance; nothing to gate);
   *   - green / no checks → advance to the next step;
   *   - still running     → `awaiting_ci` (the driver sleeps then calls {@link pollCi});
   *   - failing, budget left → dispatch a `ci-fixer` container job (`awaiting_job`);
   *   - failing, budget spent → raise a `ci_failed` notification + fail the run.
   * Shared by the initial advance and the durable `awaiting_ci` re-poll.
   */
  private async evaluateCi(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // Re-attach after a replay: a fixer is already in flight for this gate.
    if (step.ci?.phase === 'fixing' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // No CI status wired: the gate is a pass-through so the engine works without
    // GitHub CI. Advance via the normal result path.
    if (!this.ciStatusProvider) {
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: 'CI gate skipped (no CI status provider configured).',
      })
    }

    // Initialise the gate's state on first entry, resolving the attempt budget from
    // the task's merge preset (stable across polls once set).
    if (!step.ci) {
      const preset = await this.resolveMergePreset(workspaceId, block)
      step.ci = { phase: 'checking', attempts: 0, maxAttempts: preset.ciMaxAttempts, headSha: null }
    }

    const report = await this.ciStatusProvider.getStatus(workspaceId, block.id)
    step.ci.headSha = report.headSha
    const verdict = aggregateCi(report.checks)

    if (isCiGreen(verdict)) {
      // Stop polling the moment CI is green — finish the step and advance.
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output:
          verdict === 'none'
            ? 'CI gate passed: no checks configured for the PR head.'
            : `CI gate passed: ${report.checks.length} check(s) green.`,
      })
    }

    if (verdict === 'pending') {
      // Keep polling. Persist the head sha + phase so the board can reflect it.
      step.ci.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_ci', stepIndex: instance.currentStep }
    }

    // verdict === 'failure'.
    const summary = describeFailingChecks(report.checks)
    const executor = this.agentExecutor
    const canFix = isAsyncAgentExecutor(executor)
    if (canFix && step.ci.attempts < step.ci.maxAttempts) {
      return this.dispatchCiFixer(workspaceId, instance, step, block, isFinalStep, summary)
    }

    // Budget spent (or no async executor to fix with): give up and notify a human.
    await this.raiseCiFailed(workspaceId, instance, block, summary, step.ci.attempts)
    return {
      kind: 'job_failed',
      error: `CI did not pass after ${step.ci.attempts} CI-fixer attempt(s). ${summary}`.trim(),
    }
  }

  /**
   * Dispatch a `ci-fixer` container job for a failing `ci` gate: build the agent
   * context with the kind overridden to `ci-fixer` (it clones the PR head branch
   * and pushes a fix — no new PR), park on the job, and flip the gate to `fixing`.
   * Idempotent under replay via the step's `jobId` (re-attach handled in {@link evaluateCi}).
   */
  private async dispatchCiFixer(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    failureSummary: string,
  ): Promise<AdvanceResult> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      // Defensive: evaluateCi only calls this when async-capable.
      return { kind: 'job_failed', error: 'No async executor available to fix CI.' }
    }
    const base = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const context: AgentRunContext = {
      ...base,
      agentKind: CI_FIXER_AGENT_KIND,
      // Surface the failing-check summary to the fixer as resolved context.
      priorOutputs: [...base.priorOutputs, { agentKind: CI_AGENT_KIND, output: failureSummary }],
    }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.ci = {
      phase: 'fixing',
      attempts: (step.ci?.attempts ?? 0) + 1,
      maxAttempts: step.ci?.maxAttempts ?? DEFAULT_MERGE_PRESET.ciMaxAttempts,
      headSha: step.ci?.headSha ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Apply a Tester report to its step's gate. Records the report on the step, then:
   *  - greenlight → returns `null` so {@link recordStepResult} finishes + advances;
   *  - withheld + budget left → dispatches the `fixer` and parks (re-tested on its
   *    completion, see {@link pollAgentJob});
   *  - withheld + budget spent (or unparseable) → fails the run for human attention.
   */
  private async resolveTesterResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    result: AgentRunResult,
  ): Promise<AdvanceResult | null> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    let report: TestReport | null = null
    try {
      report = parseTestReport(result.testReport)
    } catch {
      report = null
    }
    if (!step.test) {
      const maxAttempts = block
        ? (await this.resolveMergePreset(workspaceId, block)).ciMaxAttempts
        : DEFAULT_MERGE_PRESET.ciMaxAttempts
      step.test = { phase: 'testing', attempts: 0, maxAttempts, lastReport: null }
    }
    if (report) step.test.lastReport = report
    step.test.phase = 'testing'
    step.subtasks = undefined

    // An unparseable report can't gate a release — fail loudly rather than silently
    // greenlighting or looping forever.
    if (!report) {
      return this.failTester(
        workspaceId,
        instance,
        step,
        block,
        result.output ?? 'Tester returned an unparseable report.',
        'Tester returned an unparseable test report.',
        step.test.attempts,
      )
    }

    // Greenlit: let the normal completion flow finish + advance the step. Defensive:
    // honour a greenlight ONLY when no blocking (high/critical) concern was raised,
    // so a harness that greenlights with open blockers can't slip a bad change through.
    if (isGreenlit(report)) return null

    // Withheld greenlight: loop the fixer if any budget remains, else give up.
    const executor = this.agentExecutor
    if (isAsyncAgentExecutor(executor) && block && step.test.attempts < step.test.maxAttempts) {
      // Reclaim the finished Tester container before dispatching the Fixer so the
      // next job boots fresh — the per-run container would otherwise re-attach to the
      // completed Tester job (idempotent dispatch by run id), replaying its result.
      await this.stopRunContainer(workspaceId, instance.id)
      return this.dispatchFixer(workspaceId, instance, step, block, report)
    }
    // Budget spent (or no async executor to fix with): give up for human attention.
    return this.failTester(
      workspaceId,
      instance,
      step,
      block,
      report.summary || 'Tester withheld its greenlight.',
      `Tester withheld its greenlight after ${step.test.attempts} fix attempt(s). ${describeTestConcerns(report)}`.trim(),
      step.test.attempts,
    )
  }

  /**
   * Give up on a Tester gate that can't be greenlit. Persists the step (left
   * un-`done`, like the CI gate — never falsely completed), raises a human-actionable
   * `test_failed` notification, and fails the run for human attention. Returns the
   * `job_failed` result the driver propagates.
   */
  private async failTester(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block | null,
    output: string,
    error: string,
    attempts: number,
  ): Promise<AdvanceResult> {
    step.output = output
    await this.executionRepository.upsert(workspaceId, instance)
    await this.raiseTestFailed(workspaceId, instance, block, error, attempts)
    await this.failRun(workspaceId, instance.id, error, 'agent')
    return { kind: 'job_failed', error }
  }

  /** Raise a `test_failed` notification when the Tester gate gives up. */
  private async raiseTestFailed(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null,
    summary: string,
    attempts: number,
  ): Promise<void> {
    if (!this.notificationService || !block) return
    await this.notificationService.raise(workspaceId, {
      type: 'test_failed',
      blockId: block.id,
      executionId: instance.id,
      title: `Tests are still failing for "${block.title}"`,
      body:
        `The Fixer agent tried ${attempts} time(s) but the Tester still won't greenlight. ${summary} ` +
        `Take a look and retry the run once fixed.`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /**
   * Dispatch a `fixer` container job for a Tester step that withheld its greenlight:
   * build the agent context with the kind overridden to `fixer` and the Tester's
   * report folded in as resolved context, park on the job, and flip the gate to
   * `fixing`. On the fixer's completion {@link pollAgentJob} re-dispatches the Tester.
   */
  private async dispatchFixer(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    report: TestReport,
  ): Promise<AdvanceResult> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      return { kind: 'job_failed', error: 'No async executor available to fix test failures.' }
    }
    // The fixer pushes its commits onto the implementation PR branch, so it can only
    // run once a coder/integrator step opened one. A Tester-only pipeline (or one whose
    // earlier step never produced a PR) can't be auto-fixed — fail cleanly with the
    // report instead of letting the job-body builder throw out of the advance.
    if (!block.pullRequest?.branch) {
      return this.failTester(
        workspaceId,
        instance,
        step,
        block,
        report.summary || 'Tester withheld its greenlight.',
        `Tester withheld its greenlight and there is no PR branch for the fixer to push to. ${describeTestConcerns(report)}`.trim(),
        step.test?.attempts ?? 0,
      )
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    const base = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const context: AgentRunContext = {
      ...base,
      agentKind: FIXER_AGENT_KIND,
      // Hand the fixer the Tester's report (what failed + the concerns) as context.
      priorOutputs: [
        ...base.priorOutputs,
        { agentKind: TESTER_AGENT_KIND, output: renderReportForFixer(report) },
      ],
    }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.startingContainer = true
    step.subtasks = undefined
    step.test = {
      phase: 'fixing',
      attempts: (step.test?.attempts ?? 0) + 1,
      maxAttempts: step.test?.maxAttempts ?? DEFAULT_MERGE_PRESET.ciMaxAttempts,
      lastReport: report,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Re-dispatch the Tester after a Fixer job finished, against the (now-fixed) PR
   * branch. Parks on the fresh Tester job; its report then drives greenlight-or-loop.
   */
  private async dispatchTester(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      return { kind: 'job_failed', error: 'No async executor available to run the tester.' }
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    const context = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.startingContainer = true
    step.subtasks = undefined
    if (step.test) step.test.phase = 'testing'
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /** Raise a `ci_failed` notification when the CI gate exhausts its fixer budget. */
  private async raiseCiFailed(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    summary: string,
    attempts: number,
  ): Promise<void> {
    if (!this.notificationService) return
    await this.notificationService.raise(workspaceId, {
      type: 'ci_failed',
      blockId: block.id,
      executionId: instance.id,
      title: `CI is still failing for "${block.title}"`,
      body:
        `The CI-fixer agent tried ${attempts} time(s) but CI is still red. ${summary} ` +
        `Take a look and retry the run once fixed.`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /**
   * Evaluate a `conflicts` step's gate once: read the PR's mergeability and decide.
   *   - no provider wired → pass-through (advance; nothing to gate);
   *   - mergeable / no PR  → advance to the next step;
   *   - still computing    → `awaiting_conflicts` (the driver sleeps then re-polls);
   *   - conflicted, budget left → dispatch a `conflict-resolver` container job;
   *   - conflicted, budget spent → fail the run (a human resolves + retries).
   * Shared by the initial advance and the durable `awaiting_conflicts` re-poll.
   */
  private async evaluateConflicts(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // Re-attach after a replay: a resolver is already in flight for this gate.
    if (step.conflicts?.phase === 'resolving' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // No mergeability provider wired: the gate is a pass-through so the engine works
    // without GitHub. Advance via the normal result path.
    if (!this.mergeabilityProvider) {
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: 'Conflict gate skipped (no mergeability provider configured).',
      })
    }

    // Initialise the gate's state on first entry, resolving the attempt budget from
    // the task's merge preset (shares the CI-fixer budget; stable across polls).
    if (!step.conflicts) {
      const preset = await this.resolveMergePreset(workspaceId, block)
      step.conflicts = {
        phase: 'checking',
        attempts: 0,
        maxAttempts: preset.ciMaxAttempts,
        headSha: null,
      }
    }

    const report = await this.mergeabilityProvider.getMergeability(workspaceId, block.id)
    step.conflicts.headSha = report.headSha

    // No PR resolved, or it merges cleanly → nothing to do; advance.
    if (report.headSha === null || report.verdict === 'mergeable') {
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output:
          report.headSha === null
            ? 'Conflict gate passed: no open PR to gate.'
            : 'Conflict gate passed: the PR merges cleanly with its base.',
      })
    }

    if (report.verdict === 'unknown') {
      // GitHub is still computing mergeability — keep polling.
      step.conflicts.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_conflicts', stepIndex: instance.currentStep }
    }

    // verdict === 'conflicted'.
    const executor = this.agentExecutor
    const canResolve = isAsyncAgentExecutor(executor)
    if (canResolve && step.conflicts.attempts < step.conflicts.maxAttempts) {
      return this.dispatchConflictResolver(workspaceId, instance, step, block, isFinalStep)
    }

    // Budget spent (or no async executor to resolve with): give up and fail the run
    // so a human resolves the conflict manually and retries.
    return {
      kind: 'job_failed',
      error:
        `The pull request still conflicts with its base after ` +
        `${step.conflicts.attempts} conflict-resolver attempt(s). Resolve the conflict ` +
        `manually, then retry the run.`,
    }
  }

  /**
   * Dispatch a `conflict-resolver` container job for a conflicted `conflicts` gate:
   * build the agent context with the kind overridden to `conflict-resolver` (it
   * clones the PR head branch, merges the base in, resolves the conflicts and pushes
   * — no new PR), park on the job, and flip the gate to `resolving`. Idempotent under
   * replay via the step's `jobId` (re-attach handled in {@link evaluateConflicts}).
   */
  private async dispatchConflictResolver(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      // Defensive: evaluateConflicts only calls this when async-capable.
      return { kind: 'job_failed', error: 'No async executor available to resolve conflicts.' }
    }
    const base = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const context: AgentRunContext = { ...base, agentKind: CONFLICT_RESOLVER_AGENT_KIND }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.conflicts = {
      phase: 'resolving',
      attempts: (step.conflicts?.attempts ?? 0) + 1,
      maxAttempts: step.conflicts?.maxAttempts ?? DEFAULT_MERGE_PRESET.ciMaxAttempts,
      headSha: step.conflicts?.headSha ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /** Provision inputs (`{{input.*}}`) derived from the block under deployment. */
  private deployInputs(block: Block): Record<string, string> {
    const inputs: Record<string, string> = {
      blockId: block.id,
      title: block.title,
      type: block.type,
      description: block.description,
    }
    return inputs
  }

  /**
   * Invoke the agent for an already-built context. Failures are swallowed into the
   * step output so a run never wedges — unless `rethrowAgentErrors` is set (the
   * durable path), in which case the error propagates so the driver's per-step
   * retry can take over.
   */
  private async runAgent(
    context: AgentRunContext,
    options: AdvanceOptions = {},
  ): Promise<AgentRunResult> {
    try {
      return await this.agentExecutor.run(context)
    } catch (error) {
      // The durable driver wants real failures to surface so its per-step retry
      // can kick in (and the error gets persisted after retries are exhausted).
      if (options.rethrowAgentErrors) throw error
      // Otherwise a failed agent must not wedge the run; record and complete.
      return {
        output: `Agent error: ${getErrorMessage(error)}`,
      }
    }
  }

  /**
   * Strictly parse a Blueprinter step's tree and reconcile it onto the board. The
   * blueprint maps the whole repository, so it is reconciled onto the run block's
   * **service frame** (walked up from the block), not the task the run targeted.
   * Best-effort and reconciler-gated: a parse/reconcile failure is logged-by-throw
   * upstream only when the reconciler is wired; with no reconciler it is a no-op so
   * the blueprint's in-repo files still land.
   */
  private async ingestBlueprint(
    workspaceId: string,
    blockId: string,
    rawService: unknown,
  ): Promise<void> {
    if (!this.blueprintReconciler) return
    let service: BlueprintService
    try {
      service = parseBlueprintService(rawService)
    } catch {
      // A malformed tree must not fail the step (the in-repo files are already
      // committed); skip the board reconcile.
      return
    }
    const frameId = await this.resolveServiceFrameId(workspaceId, blockId)
    await this.blueprintReconciler.reconcileBlueprint(workspaceId, frameId, service)
    // The reconcile may have created/updated module + task blocks that aren't
    // individually pushed; nudge clients to refresh the board so they appear. Name the service
    // frame so the refresh fans out to every board mounting this shared service.
    await this.events.boardChanged(workspaceId, 'blueprint-reconciled', frameId)
  }

  /**
   * Strictly validate a spec-writer step's unified specification. The canonical record
   * is the in-repo `spec/` files the harness already committed; this is the trust
   * boundary (a malformed payload is dropped, never trusted) plus a client refresh
   * nudge. A persisted board projection is a deliberate later phase.
   */
  private async ingestSpec(workspaceId: string, rawDoc: unknown): Promise<void> {
    try {
      parseSpecDoc(rawDoc)
    } catch {
      // A malformed doc must not fail the step (the in-repo files are already
      // committed); skip the refresh.
      return
    }
    // Nudge clients to refresh so they can re-read the service's spec files.
    await this.events.boardChanged(workspaceId, 'requirements-updated')
  }

  /**
   * The collected requirements of every task under `block`'s service frame, for the
   * spec-writer step to aggregate. Each task contributes its reworked
   * ("incorporated") requirements when present — the standard-format document the
   * rework step produced — and falls back to its plain description otherwise. Returns
   * an empty list when the block has no service frame (the writer then has only the
   * prior doc).
   */
  private async gatherServiceTasks(
    workspaceId: string,
    block: Block,
  ): Promise<{ id: string; title: string; description: string }[]> {
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const frame = serviceOf(blocks, block)
    if (!frame) return []
    const within = descendantIds(blocks, frame.id)
    const tasks = blocks.filter((b) => within.has(b.id) && b.level === 'task')
    return Promise.all(
      tasks.map(async (b) => ({
        id: b.id,
        title: b.title,
        description: (await this.resolveReworkedRequirements(workspaceId, b.id)) ?? b.description,
      })),
    )
  }

  /**
   * The reworked ("incorporated") requirements for a block — the standard-format
   * document the requirements-rework step produced — or `null` when the feature is
   * unwired or the block has no incorporated review yet. Used both to substitute the
   * agent context for every step and to feed the spec-writer.
   */
  private async resolveReworkedRequirements(
    workspaceId: string,
    blockId: string,
  ): Promise<string | null> {
    if (!this.requirementReviews) return null
    const review = await this.requirementReviews.getByBlock(workspaceId, blockId)
    if (review?.status === 'incorporated' && review.incorporatedRequirements) {
      return review.incorporatedRequirements
    }
    return null
  }

  /** Walk up `parentId` from a block to its top-level service frame id (or itself). */
  private async resolveServiceFrameId(
    workspaceId: string,
    blockId: string,
  ): Promise<string | null> {
    let current = await this.blockRepository.get(workspaceId, blockId)
    // Bounded walk (the tree is at most frame → module → task) guarded against cycles.
    for (let i = 0; current && i < 8; i++) {
      if (current.level === 'frame' || !current.parentId) return current.id
      current = await this.blockRepository.get(workspaceId, current.parentId)
    }
    return current?.id ?? null
  }

  /**
   * Resolve the service-level (frame) configuration for a run's block — the
   * Tester's local-infra docker-compose path / "no infra" flag and the provisioning
   * provider + instance size — by walking up to the service frame. When the frame
   * pins no cloud provider it inherits the owning account's `defaultCloudProvider`
   * (so the account-level default actually reaches dispatch, not just the UI).
   * Returns undefined when no frame carries any of these settings, so callers can
   * spread it conditionally onto the agent context.
   */
  private async resolveServiceConfig(
    workspaceId: string,
    block: Block,
  ): Promise<AgentRunContext['service'] | undefined> {
    const frame =
      block.level === 'frame'
        ? block
        : await this.resolveServiceFrameId(workspaceId, block.id).then((id) =>
            id ? this.blockRepository.get(workspaceId, id) : null,
          )
    if (!frame) return undefined
    const service: NonNullable<AgentRunContext['service']> = {}
    if (frame.testComposePath) service.testComposePath = frame.testComposePath
    if (frame.noInfraDependencies) service.noInfraDependencies = frame.noInfraDependencies
    if (frame.cloudProvider) service.cloudProvider = frame.cloudProvider
    else {
      // No per-service override: fall back to the owning account's default provider
      // so a pool/local deployment honours the account-level choice at dispatch.
      const accountDefault = await this.resolveAccountDefaultProvider(workspaceId)
      if (accountDefault) service.cloudProvider = accountDefault
    }
    if (frame.instanceSize) service.instanceSize = frame.instanceSize
    return Object.keys(service).length ? service : undefined
  }

  /**
   * The owning account's `defaultCloudProvider`, or undefined when the workspace
   * has no account or the account pins no default (so the transport keeps its own).
   */
  private async resolveAccountDefaultProvider(
    workspaceId: string,
  ): Promise<CloudProvider | undefined> {
    const workspace = await this.workspaceRepository.get(workspaceId)
    if (!workspace?.accountId) return undefined
    const account = await this.accountRepository.get(workspace.accountId)
    return account?.defaultCloudProvider
  }

  /** Assemble the {@link AgentRunContext} for a step from the run + block state. */
  private async buildAgentContext(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    block: Block,
  ): Promise<AgentRunContext> {
    // When a block's requirements have been reworked, that standardized document is
    // the single source of truth for every agent step: it already folds in the
    // description plus the linked docs / tracker issues, so it REPLACES the
    // description and the (now-redundant) doc/task context. Reviews are only ever run
    // on task blocks, so skip the lookup entirely for frames/modules — that keeps the
    // extra read off every container/frame step rather than on the whole hot path.
    const reworked =
      block.level === 'task' ? await this.resolveReworkedRequirements(workspaceId, block.id) : null
    const description = reworked ?? block.description
    const contextDocs = reworked ? [] : await this.resolveContextDocs(workspaceId, block.id)
    const contextTasks = reworked ? [] : await this.resolveContextTasks(workspaceId, block.id)
    const environment = await this.resolveEnvironment(workspaceId, block.id)
    const service = await this.resolveServiceConfig(workspaceId, block)
    const priorOutputs = instance.steps
      .slice(0, instance.currentStep)
      .filter((s) => s.output)
      .map((s) => ({ agentKind: s.agentKind, output: s.output! }))
    // Resolve the best-practice fragments to inject for this step. `code-aware` kinds
    // get the running service's selected fragments unioned with the block's own pins;
    // other kinds keep only their block pins. Recorded on the step for observability.
    const resolved = await this.resolveFragments(workspaceId, step, block)
    // The spec-writer aggregates the collected requirements of EVERY task under the
    // service frame; gather them only for that kind (a no-op otherwise).
    const serviceTasks =
      step.agentKind === SPEC_WRITER_AGENT_KIND
        ? await this.gatherServiceTasks(workspaceId, block)
        : undefined
    return {
      agentKind: step.agentKind,
      pipelineName: instance.pipelineName,
      workspaceId,
      executionId: instance.id,
      // Carry the run initiator so the container executor can lease their OWN personal
      // (individual-usage) subscription for the step. Null on system/dev runs.
      ...(instance.initiatedBy != null ? { initiatedByUserId: instance.initiatedBy } : {}),
      stepIndex: instance.currentStep,
      isFinalStep,
      block: {
        id: block.id,
        title: block.title,
        type: block.type,
        description,
        fragmentIds: block.fragmentIds,
        ...(resolved ? { resolvedFragments: resolved.fragments } : {}),
        modelId: block.modelId,
        ...(block.agentConfig ? { agentConfig: block.agentConfig } : {}),
        ...(block.pullRequest ? { pullRequest: block.pullRequest } : {}),
        ...(contextDocs.length ? { contextDocs } : {}),
        ...(contextTasks.length ? { contextTasks } : {}),
      },
      ...(environment ? { environment } : {}),
      ...(service ? { service } : {}),
      ...(serviceTasks ? { serviceTasks } : {}),
      priorOutputs,
      decisions: instance.steps
        .filter((s, i) => i < instance.currentStep && s.decision?.chosen)
        .map((s) => ({ question: s.decision!.question, chosen: s.decision!.chosen! })),
      resolvedDecision: step.decision?.chosen
        ? { question: step.decision.question, chosen: step.decision.chosen }
        : null,
      // A re-run triggered either by a human "Request changes" on this step's
      // approval gate OR by a downstream companion looping it back for rework: hand
      // the agent its previous proposal plus the feedback so it revises rather than
      // starting over. The companion's automatic rework (`step.rework`) and the
      // human's gate feedback share one revision shape; the companion path takes
      // precedence when both are present.
      ...buildRevisionContext(step),
    }
  }

  /**
   * Resolve the best-practice fragments to fold into a step's system prompt. Service
   * fragments reach an agent ONLY when its kind carries the `code-aware` trait: those
   * kinds get the running SERVICE's selected fragments (the frame's
   * `serviceFragmentIds`, seeded from the workspace default and editable per service)
   * unioned with the block's own manual pins, resolved against the universal pool. A
   * non-code-aware kind returns null so `composeBlockSystemPrompt` falls back to the
   * block's own `fragmentIds` unchanged. Records the selected ids on the step for
   * observability; never throws (a lookup failure degrades to the block pins).
   */
  private async resolveFragments(
    workspaceId: string,
    step: PipelineStep,
    block: Block,
  ): Promise<{ fragments: { id: string; body: string }[] } | null> {
    if (!hasTrait(step.agentKind, CODE_AWARE_TRAIT)) return null
    try {
      const serviceIds = await this.resolveServiceFragmentIds(workspaceId, block)
      // Service standards first, then the block's own pins; deduped, stable order.
      const ids: string[] = []
      const seen = new Set<string>()
      for (const id of [...serviceIds, ...(block.fragmentIds ?? [])]) {
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      const fragments = ids
        .map((id) => {
          const fragment = getFragment(id)
          return fragment ? { id, body: fragment.body } : null
        })
        .filter((f): f is { id: string; body: string } => f !== null)
      if (fragments.length === 0) return null
      step.selectedFragmentIds = fragments.map((f) => f.id)
      return { fragments }
    } catch {
      // Resolution must never wedge a run; fall back to the block's own pins.
      return null
    }
  }

  /**
   * The selected best-practice fragment ids of the block's owning service frame. Walks
   * up from the block we already hold (bounded: frame → module → task, cycle-guarded),
   * reading the frame's `serviceFragmentIds` — without re-fetching the block in hand or
   * fetching the frame twice.
   */
  private async resolveServiceFragmentIds(workspaceId: string, block: Block): Promise<string[]> {
    let current: Block | null = block
    for (let i = 0; current && i < 8; i++) {
      if (current.level === 'frame' || !current.parentId) return current.serviceFragmentIds ?? []
      current = await this.blockRepository.get(workspaceId, current.parentId)
    }
    return []
  }

  /**
   * Resolve documents (from any source) linked to the running block into compact
   * agent context. A no-op unless the document-source integration is wired (the
   * repository is an optional dependency), so the engine stays unchanged when it
   * is off.
   */
  private async resolveContextDocs(
    workspaceId: string,
    blockId: string,
  ): Promise<{ title: string; url: string; excerpt: string }[]> {
    if (!this.documents) return []
    const docs = await this.documents.listByBlock(workspaceId, blockId)
    return docs.map((d) => ({ title: d.title, url: d.url, excerpt: d.excerpt }))
  }

  /**
   * Resolve tracker issues (from any source) linked to the running block into
   * structured agent context. A no-op unless the task-source integration is
   * wired (the repository is an optional dependency), so the engine stays
   * unchanged when it is off.
   */
  private async resolveContextTasks(workspaceId: string, blockId: string) {
    if (!this.tasks) return []
    const tasks = await this.tasks.listByBlock(workspaceId, blockId)
    return tasks.map((t) => ({
      key: t.externalId,
      url: t.url,
      title: t.title,
      status: t.status,
      type: t.type,
      assignee: t.assignee,
      priority: t.priority,
      labels: t.labels,
      description: t.description,
      comments: t.comments,
    }))
  }

  /**
   * Resolve the live ephemeral environment provisioned for the running block
   * into compact agent context. A no-op unless the environment integration is
   * wired (the provisioning service is an optional dependency), so the engine
   * stays unchanged when it is off.
   */
  private async resolveEnvironment(workspaceId: string, blockId: string) {
    if (!this.environmentProvisioning) return null
    return this.environmentProvisioning.resolveForBlock(workspaceId, blockId)
  }

  /**
   * Push the run's latest state to subscribed clients, alongside its rolled-up
   * block so the board updates without a refetch. Best-effort: the publisher
   * swallows its own errors, and the persisted run remains the source of truth.
   */
  private async emitInstance(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // The metrics rollup and the block fetch are independent, so run them concurrently
    // — the rollup adds no serial latency to the (frequent) emit path.
    const [, block] = await Promise.all([
      this.attachStepMetrics(workspaceId, instance),
      this.blockRepository.get(workspaceId, instance.blockId),
    ])
    await this.events.executionChanged(workspaceId, instance, block)
    // When a run reaches a terminal state, delete its per-run personal-credential
    // activation immediately (individual-usage subscriptions) so the system-encrypted
    // token copy doesn't linger to its TTL. Best-effort + idempotent — a missing repo or
    // a re-emit of an already-cleared run is a no-op, and a failure here must never
    // derail the emit.
    if (
      this.subscriptionActivations &&
      (instance.status === 'done' || instance.status === 'failed')
    ) {
      try {
        await this.subscriptionActivations.deleteByExecution(instance.id)
      } catch {
        // Swallow — a failure here must never derail the emit. This is not a silent
        // data-loss path: the TTL sweep reclaims the row as a backstop, and the sweep
        // (Worker cron / Node retention timer) logs its own errors, so a *systemic*
        // cleanup failure surfaces there rather than being lost here.
      }
    }
  }

  /**
   * Roll the run's recorded LLM calls into per-step `metrics` for the board, in
   * place on the emitted instance. The proxy keys calls by execution + agentKind
   * (not step index), so the aggregate is per-agent-kind within the run; steps
   * sharing a kind get the same rollup. Best-effort and a no-op when the sink is
   * not wired, so it never blocks an emit.
   */
  private async attachStepMetrics(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    if (!this.llmObservability) return
    try {
      const summaries = await this.llmObservability.summarizeByExecution(workspaceId, instance.id)
      if (summaries.length === 0) return
      const byKind = new Map(summaries.map((s) => [s.agentKind, s]))
      for (const step of instance.steps) {
        const s = byKind.get(step.agentKind)
        if (!s) continue
        step.metrics = {
          calls: s.calls,
          promptTokens: s.promptTokens,
          completionTokens: s.completionTokens,
          peakCompletionTokens: s.peakCompletionTokens,
          maxOutputTokens: s.maxOutputTokens,
          truncatedCalls: s.truncatedCalls,
          upstreamMs: s.upstreamMs,
          overheadMs: s.overheadMs,
          errors: s.errors,
          warnings: s.warnings,
        }
      }
    } catch (error) {
      // Observability is best-effort; never block an emit on a metrics read.
      void error
    }
  }

  /** Set the block's in-progress/blocked status and step-completion progress. */
  private async updateBlockProgress(
    workspaceId: string,
    instance: ExecutionInstance,
    status: 'in_progress' | 'blocked',
  ): Promise<void> {
    const total = instance.steps.length || 1
    const done = instance.steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status,
      progress: Math.min(1, done / total),
    })
  }

  /**
   * A pipeline finished. A frame becomes `done` (a mapping-only run leaves it
   * `ready`). A *task* never auto-`done`s from a confidence score any more — that
   * looked merged when the PR was still open with red CI. Instead:
   *   - if the pipeline has a `merger` step, it already owned the merge/notify
   *     decision (see {@link resolveMergerStep}); we only backstop a missing one;
   *   - otherwise the work is complete but unmerged: leave the PR open (`pr_ready`)
   *     and raise a `pipeline_complete` notification for a human to confirm + merge.
   * `done` now strictly means the PR was merged (see {@link finalizeMerge}).
   */
  private async finalizeBlock(
    workspaceId: string,
    instance: ExecutionInstance,
    confidence: number | undefined,
  ): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block || block.status === 'done') return

    if ((block.level ?? 'frame') !== 'task') {
      // A mapping-only run (just the `blueprints` step, e.g. kicked off after a
      // bootstrap) leaves the service frame `ready` and droppable rather than
      // marking the whole service "done".
      const mappingOnly = instance.steps.every((s) => s.agentKind === 'blueprints')
      await this.blockRepository.update(workspaceId, block.id, {
        status: mappingOnly ? 'ready' : 'done',
        progress: 1,
      })
      return
    }

    // Confidence is recorded by the caller (recordStepResult) before any merge, so
    // it persists on both the merge and review paths; `confidence` is unused here.
    void confidence

    const hasMerger = instance.steps.some((s) => s.agentKind === MERGER_AGENT_KIND)
    if (hasMerger) {
      // The `merger` step already merged (→ `done`) or raised a review (→ `pr_ready`).
      // Only backstop the case where it produced no decision at all.
      const fresh = await this.blockRepository.get(workspaceId, block.id)
      if (fresh && fresh.status !== 'done' && fresh.status !== 'pr_ready') {
        await this.blockRepository.update(workspaceId, block.id, {
          status: 'pr_ready',
          progress: 1,
        })
      }
      return
    }

    // No merger in this pipeline: complete but unmerged — ask a human to confirm.
    await this.blockRepository.update(workspaceId, block.id, { status: 'pr_ready', progress: 1 })
    await this.raisePipelineComplete(workspaceId, instance, block)
  }

  /**
   * Merge a block's PR for real, then mark it `done`. The remote merge happens
   * FIRST (via the {@link PullRequestMerger} port) and only on its success does the
   * block flip to `done` — so `done` provably means "merged", not a board-only
   * status. When no merger is wired (tests) this degrades to the old board-only
   * flip. Throws if the remote merge fails so callers can fall back to a manual
   * merge / review notification.
   */
  private async finalizeMerge(workspaceId: string, blockId: string): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, blockId)
    if (!block) return
    if (this.prMerger && block.pullRequest) {
      // Throws on a blocked/failed merge — the caller decides what to do next.
      await this.prMerger.mergeForBlock(workspaceId, blockId)
    }
    await this.blockRepository.update(workspaceId, blockId, { status: 'done', progress: 1 })
    if ((block.level ?? 'frame') === 'task') {
      await this.applyModuleAssignment(workspaceId, blockId)
    }
  }

  /**
   * Resolve a `merger` step's assessment: parse + validate it, compare each axis
   * against the task's resolved merge preset, and either merge the PR for real
   * (all within threshold) or raise a `merge_review` notification leaving the
   * block `pr_ready`. A malformed assessment or a failed auto-merge also falls back
   * to a review notification — never a silent merge.
   */
  private async resolveMergerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    rawAssessment: unknown,
  ): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return

    let assessment: MergeAssessment | null = null
    try {
      assessment = parseMergeAssessment(rawAssessment)
    } catch {
      assessment = null
    }

    const preset = await this.resolveMergePreset(workspaceId, block)
    const within =
      assessment !== null &&
      assessment.complexity <= preset.maxComplexity &&
      assessment.risk <= preset.maxRisk &&
      assessment.impact <= preset.maxImpact

    if (within) {
      try {
        await this.finalizeMerge(workspaceId, block.id)
        return
      } catch {
        // Auto-merge failed (e.g. branch protection / conflict): fall through to a
        // review notification so a human can sort it out.
      }
    }

    await this.blockRepository.update(workspaceId, block.id, { status: 'pr_ready', progress: 1 })
    await this.raiseMergeReview(workspaceId, instance, block, assessment)
  }

  /**
   * Resolve the merge threshold preset that governs a task: its explicitly-picked
   * preset, else the workspace default, else the built-in {@link DEFAULT_MERGE_PRESET}.
   * Returns just the thresholds the engine compares against (+ the CI attempt budget).
   */
  private async resolveMergePreset(
    workspaceId: string,
    block: Block,
  ): Promise<{
    maxComplexity: number
    maxRisk: number
    maxImpact: number
    ciMaxAttempts: number
  }> {
    if (this.mergePresetRepository) {
      if (block.mergePresetId) {
        const picked = await this.mergePresetRepository.get(workspaceId, block.mergePresetId)
        if (picked) return picked
      }
      const fallback = await this.mergePresetRepository.getDefault(workspaceId)
      if (fallback) return fallback
    }
    return DEFAULT_MERGE_PRESET
  }

  /** Raise a `merge_review` notification carrying the agent's assessment + the PR. */
  private async raiseMergeReview(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    assessment: MergeAssessment | null,
  ): Promise<void> {
    if (!this.notificationService) return
    const body = assessment
      ? `The merger scored this PR outside the task's auto-merge thresholds ` +
        `(complexity ${pct(assessment.complexity)}, risk ${pct(assessment.risk)}, ` +
        `impact ${pct(assessment.impact)}). ${assessment.rationale}`
      : `The merger could not produce a valid assessment for this PR. Review and merge manually.`
    await this.notificationService.raise(workspaceId, {
      type: 'merge_review',
      blockId: block.id,
      executionId: instance.id,
      title: `Review PR for "${block.title}"`,
      body,
      payload: {
        ...(assessment ? { assessment } : {}),
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /** Raise a `pipeline_complete` notification for a no-merger run awaiting confirmation. */
  private async raisePipelineComplete(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<void> {
    if (!this.notificationService) return
    await this.notificationService.raise(workspaceId, {
      type: 'pipeline_complete',
      blockId: block.id,
      executionId: instance.id,
      title: `Confirm "${block.title}" is complete`,
      body:
        `The "${instance.pipelineName}" pipeline finished and opened a PR, but it has no ` +
        `merger step. Review the work and confirm it as complete (this merges the PR).`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /**
   * Implementing a task assigned to a module materialises that module: create it
   * in the service if missing, then move the task inside it.
   */
  private async applyModuleAssignment(workspaceId: string, taskId: string): Promise<void> {
    const task = await this.blockRepository.get(workspaceId, taskId)
    if (!task || !task.moduleName) return
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const service = serviceOf(blocks, task)
    if (!service) return

    let module = blocks.find(
      (b) => b.parentId === service.id && b.level === 'module' && b.title === task.moduleName,
    )
    if (!module) {
      module = await this.board.addModule(workspaceId, service.id, {
        name: task.moduleName,
      })
    }
    if (module.id !== task.parentId) {
      const n = blocks.filter((b) => b.parentId === module!.id && b.level === 'task').length
      await this.board.reparent(workspaceId, taskId, {
        parentId: module.id,
        position: { x: 16 + (n % 2) * 190, y: 40 + Math.floor(n / 2) * 130 },
      })
    }
    // A module node appeared and/or a task changed parent — the per-block event
    // can't express that hierarchy change, so signal a coarse board refresh. Name the moved
    // task so the refresh fans out to every board mounting its shared service.
    await this.events.boardChanged(workspaceId, 'module', taskId)
  }

  /** Resolve a pending decision; the run's next step lets the agent finish it. */
  async resolveDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.decision?.id === decisionId)
    if (!step || !step.decision) throw new NotFoundError('Decision', decisionId)

    step.decision.chosen = choice
    this.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    // Wake the parked durable run, if any. The DB write above remains the source
    // of truth (so the backstop sweeper can still re-drive it); the signal is an
    // optimisation that lets the workflow continue immediately.
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, choice)
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Expire a decision no human resolved within the timeout. Safe + idempotent: a no-op
   * unless the run is still parked (`blocked`) on EXACTLY this decision/approval id, so a
   * decision already resolved (the run advanced past it) or an already-terminal run is left
   * untouched. The Node durable driver schedules this `decisionTimeout` after parking on a
   * decision; the Cloudflare driver instead relies on `waitForEvent`'s own timeout firing
   * its failRun. Keeping the check here (not in the runtime) means both facades reason about
   * decision state identically.
   */
  async expireDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
  ): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || instance.status !== 'blocked') return
    const step = instance.steps[instance.currentStep]
    const pendingId = step?.decision?.id ?? step?.approval?.id
    if (step?.state !== 'waiting_decision' || pendingId !== decisionId) return
    await this.failRun(
      workspaceId,
      executionId,
      'Decision timed out awaiting a human response',
      'decision_timeout',
    )
  }

  /**
   * Approve a step's gated proposal: the run advances to the next step, carrying
   * the (optionally human-edited) proposal forward as context. Mirrors
   * {@link resolveDecision}'s durable-wake but *advances* the pipeline instead of
   * re-running the step (the step is already done). Idempotent — re-approving an
   * already-approved gate is a no-op.
   */
  async approveStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    opts: { proposal?: string } = {},
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const stepIndex = instance.steps.findIndex((s) => s.approval?.id === approvalId)
    const step = instance.steps[stepIndex]
    if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
    if (step.approval.status === 'approved') return instance

    // A human edit to the proposal replaces the agent's text, so the revised
    // proposal is what downstream steps read (via priorOutputs).
    if (opts.proposal !== undefined) {
      step.output = opts.proposal
      step.approval.proposal = opts.proposal
    }
    step.approval.status = 'approved'
    this.finishStep(step)
    step.progress = 1

    const isFinalStep = stepIndex === instance.steps.length - 1
    if (isFinalStep) {
      // A gate is never raised on the final step, but stay defensive: just finish.
      instance.status = 'done'
      await this.finalizeBlock(workspaceId, instance, undefined)
      await this.stopRunContainer(workspaceId, instance.id)
    } else {
      instance.currentStep = stepIndex + 1
      const next = instance.steps[instance.currentStep]
      if (next) this.startStep(next)
      if (instance.status === 'blocked') instance.status = 'running'
      await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    }
    await this.executionRepository.upsert(workspaceId, instance)
    // Wake the parked durable run (the DB write above is the source of truth).
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Request changes on a step's gated proposal: the same step re-runs with the
   * human's freeform feedback and/or per-block comments (and its prior proposal)
   * folded into the agent's context (see `buildAgentContext`). The run is left
   * `running` on the same step; on the re-run's completion the gate is raised
   * afresh. At least one of `feedback`/`comments` is expected (the controller
   * validates this), but an empty review is harmless — the agent simply re-runs.
   */
  async requestStepChanges(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    review: { feedback?: string; comments?: StepReviewComment[] },
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.approval?.id === approvalId)
    if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
    if (step.approval.status === 'approved') {
      throw new ConflictError(`Approval '${approvalId}' is already approved`)
    }
    if (step.approval.status === 'rejected') {
      throw new ConflictError(`Approval '${approvalId}' was rejected`)
    }
    // A re-run is already in flight (and will raise a fresh gate on completion);
    // acting on this now-stale gate id would dispatch duplicate work.
    if (step.approval.status === 'changes_requested') {
      throw new ConflictError(`Approval '${approvalId}' is already being re-run`)
    }

    const stepIndex = instance.steps.findIndex((s) => s.approval?.id === approvalId)

    step.approval.status = 'changes_requested'
    step.approval.feedback = review.feedback
    step.approval.comments = review.comments?.length ? review.comments : undefined

    // A companion's gate reviews the PRODUCER's output, not the companion's own work:
    // requesting changes here must re-run the producer (with the human's feedback
    // folded in) and re-grade, NOT re-run the companion. Redirect the rework to the
    // nearest preceding step of one of the companion's target kinds.
    if (isCompanionKind(step.agentKind)) {
      const targets = companionTargets(step.agentKind)
      let producerIndex = -1
      for (let i = stepIndex - 1; i >= 0; i--) {
        if (targets.includes(instance.steps[i]!.agentKind)) {
          producerIndex = i
          break
        }
      }
      const producer = producerIndex >= 0 ? instance.steps[producerIndex]! : undefined
      if (producer) {
        // Re-run the producer (with the human's feedback) and every step up to and
        // including the companion, then the companion re-grades. Does NOT touch the
        // companion's automatic-rework budget — a human-driven iteration is unbounded.
        const previousProposal = producer.output ?? step.approval.proposal
        this.rerunProducerThrough(instance, producerIndex, stepIndex, {
          previousProposal,
          feedback: review.feedback ?? '',
          ...(review.comments?.length ? { comments: review.comments } : {}),
        })
        if (instance.status === 'blocked') instance.status = 'running'
        await this.executionRepository.upsert(workspaceId, instance)
        await this.workRunner.signalDecision(
          workspaceId,
          instance.id,
          approvalId,
          'changes_requested',
        )
        await this.emitInstance(workspaceId, instance)
        return instance
      }
    }

    // Drop the live job handle so the re-run dispatches fresh work rather than
    // re-attaching to the finished job (async steps); inline steps ignore this.
    step.jobId = undefined
    // A requested re-run is a fresh execution: clear the prior timing so the next
    // start/finish times this attempt rather than spanning the human gate wait.
    step.startedAt = null
    step.finishedAt = null
    this.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
    await this.executionRepository.upsert(workspaceId, instance)
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'changes_requested')
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Reject a step's gated proposal: the run stops entirely. The gate is marked
   * `rejected` and the run is failed with a dedicated `rejected` failure kind, so
   * the board surfaces it via the shared failure banner (block → `blocked`) with a
   * Retry affordance. The parked durable run is woken so it observes the now-terminal
   * status and stops (the workflow's advance loop no-ops on a non-running run).
   * Idempotent — rejecting an already-terminal gate is a no-op.
   */
  async rejectStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    reason?: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.approval?.id === approvalId)
    if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
    if (step.approval.status === 'approved') {
      throw new ConflictError(`Approval '${approvalId}' is already approved`)
    }
    // A re-run is in flight; this gate id is stale (a fresh one is raised on its
    // completion). Reject the current gate via that fresh id, not this one.
    if (step.approval.status === 'changes_requested') {
      throw new ConflictError(`Approval '${approvalId}' is being re-run`)
    }
    // Already rejected (and the run already failed): return as-is.
    if (step.approval.status === 'rejected') {
      return (await this.executionRepository.get(workspaceId, executionId)) ?? instance
    }

    step.approval.status = 'rejected'
    if (reason) step.approval.feedback = reason
    await this.executionRepository.upsert(workspaceId, instance)
    const message = reason
      ? `A reviewer rejected the proposal: ${reason}`
      : 'A reviewer rejected the proposal, stopping the run.'
    // failRun persists the terminal failure + flips the block to `blocked` and emits.
    await this.failRun(workspaceId, executionId, message, 'rejected')
    // Wake the parked durable run; it re-reads the now-terminal status and stops.
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'rejected')
    return assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
  }

  /** Merge an open PR: a block moves from `pr_ready` to `done`. */
  async mergePr(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, blockId)
    if (block.status !== 'pr_ready') {
      throw new ConflictError(`Block '${blockId}' has no PR awaiting merge`)
    }
    await this.finalizeMerge(workspaceId, blockId)
    return this.requireBlock(workspaceId, blockId)
  }

  /**
   * Record a terminal agent failure: persist a structured {@link AgentFailure},
   * flip the run to `failed`, and mark the block `blocked` (needs attention) — NOT
   * `pr_ready`, which looked like success and hid the failure. The board then
   * renders the same failure banner + retry as a failed bootstrap. Called by the
   * durable driver once a step has exhausted its retries (or a job/decision
   * faulted); `kind` classifies the cause so the right hint is shown.
   */
  async failRun(
    workspaceId: string,
    executionId: string,
    message: string,
    kind: AgentFailureKind = 'agent',
    detail: string | null = null,
  ): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) return
    // Reclaim the per-run container on the failure path too: a failed run otherwise
    // leaves its container to idle out sleepAfter. This is the single funnel for
    // every failure kind (job_failed from the driver, the spend/decision timeouts,
    // and the user-facing stopRun, which already reclaimed — the call is idempotent).
    await this.stopRunContainer(workspaceId, executionId)
    const failure: AgentFailure = {
      kind,
      message,
      detail,
      hint: EXECUTION_FAILURE_HINTS[kind] ?? null,
      occurredAt: this.clock.now(),
      lastSubtasks: instance.steps[instance.currentStep]?.subtasks ?? null,
    }
    await this.executionRepository.markFailed(workspaceId, executionId, failure)
    // Progress reflects how far the pipeline got before failing.
    const done = instance.steps.filter((s) => s.state === 'done').length
    const progress = instance.steps.length > 0 ? done / instance.steps.length : 0
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status: 'blocked',
      progress,
    })
    const failed = await this.executionRepository.get(workspaceId, executionId)
    if (failed) await this.emitInstance(workspaceId, failed)
  }

  /**
   * Retry a failed run: re-drive the same pipeline on the same block, **resuming
   * from the step that actually failed** rather than restarting from step 0. The
   * steps that already completed are preserved (so a `coder` failure in `pl_full`
   * doesn't re-run the human-gated `requirements`/`architect` steps before it);
   * the failed step and everything after it are reset to a clean, re-runnable
   * state. Only a `failed` run can be retried.
   *
   * A fresh instance id is minted because the durable runner addresses one
   * Workflows instance per execution id and the failed one is terminal — the new
   * instance simply starts with `currentStep` pointed at the failed step, so the
   * driver advances forward from there and never re-issues the completed steps'
   * work. Mirrors {@link BootstrapService.retry}; both are reached via the unified
   * `POST /agent-runs/:id/retry` endpoint.
   */
  async retry(
    workspaceId: string,
    executionId: string,
    /** The retrying user (their personal subscription is used for individual-usage
     *  models). Falls back to the original initiator when omitted. */
    initiatedBy?: string | null,
    /** Mint the per-run personal-credential activation (see {@link start}). */
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const previous = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (previous.status !== 'failed') {
      throw new ConflictError(`Only a failed run can be retried (run is '${previous.status}').`)
    }
    await this.requireBlock(workspaceId, previous.blockId)

    const { steps, currentStep } = planResumedSteps(previous)
    // Mint the activation before replacing the failed run, so a bad password aborts
    // the retry without losing the retryable terminal run.
    const newId = this.idGenerator.next('exec')
    await activate?.(newId)
    // Replace the terminal failed run for this block with the resumed one (single
    // run per block, matching the board's by-block projection).
    await this.executionRepository.deleteByBlock(workspaceId, previous.blockId)
    const instance: ExecutionInstance = {
      id: newId,
      blockId: previous.blockId,
      pipelineId: previous.pipelineId,
      pipelineName: previous.pipelineName,
      steps,
      currentStep,
      status: 'running',
      initiatedBy: initiatedBy ?? previous.initiatedBy ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    const done = steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Resume every run paused by the spend safeguard in this workspace. Flips them
   * back to `running` and re-drives the durable runner. If the budget is still
   * exhausted the spend gate will simply pause them again on their next step.
   */
  async resumePaused(workspaceId: string): Promise<ExecutionInstance[]> {
    await this.requireWorkspace(workspaceId)
    const instances = await this.executionRepository.listByWorkspace(workspaceId)
    const paused = instances.filter((e) => e.status === 'paused')
    for (const instance of paused) {
      instance.status = 'running'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.workRunner.startRun(workspaceId, instance.id)
      await this.emitInstance(workspaceId, instance)
    }
    return this.executionRepository.listByWorkspace(workspaceId)
  }

  /** Cancel the run on a block, returning it to `planned`. */
  async cancel(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, blockId)
    // Tear down the durable run (if any) AND its per-run container before removing
    // the record, so a cancel never leaves a container running until its watchdog.
    const existing = await this.executionRepository.getByBlock(workspaceId, blockId)
    if (existing) {
      await this.stopRunContainer(workspaceId, existing.id)
      await this.workRunner.cancelRun(workspaceId, existing.id)
    }
    await this.executionRepository.deleteByBlock(workspaceId, blockId)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'planned',
      progress: 0,
      executionId: null,
    })
    // The run record is gone and the block is back to planned; the client can't
    // reconstruct that from a per-instance event, so signal a coarse refresh. Name the block
    // so the refresh fans out to every board mounting its shared service.
    await this.events.boardChanged(workspaceId, 'cancel', blockId)
    return this.requireBlock(workspaceId, blockId)
  }

  /**
   * Explicitly stop a *running* run by id (the unified `POST /agent-runs/:id/stop`
   * surface): kill its per-run container, tear down the durable driver, then record
   * a terminal `cancelled` failure so the board shows the run stopped (with retry)
   * rather than spinning forever. Idempotent — a run already terminal is returned
   * as-is. `opts.reason`/`opts.kind` let the orphan sweep reuse this with its own
   * wording instead of the user-facing default.
   */
  async stopRun(
    workspaceId: string,
    executionId: string,
    opts: { reason?: string; kind?: AgentFailureKind } = {},
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (instance.status === 'failed' || instance.status === 'done') return instance
    await this.stopRunContainer(workspaceId, executionId)
    await this.workRunner.cancelRun(workspaceId, executionId)
    await this.failRun(
      workspaceId,
      executionId,
      opts.reason ?? 'Stopped by the user.',
      opts.kind ?? 'cancelled',
    )
    return assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
  }

  /**
   * Tear down every run under a block subtree — kill each container, terminate each
   * durable driver, and delete the run record — so deleting a service/module never
   * orphans a container or a Workflows instance. Best-effort and silent: the board
   * delete that follows emits the coarse refresh, so no per-run event is needed.
   */
  async teardownForBlockTree(workspaceId: string, rootId: string): Promise<void> {
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    for (const blockId of descendantIds(blocks, rootId)) {
      const run = await this.executionRepository.getByBlock(workspaceId, blockId)
      if (!run) continue
      await this.stopRunContainer(workspaceId, run.id)
      await this.workRunner.cancelRun(workspaceId, run.id)
      await this.executionRepository.deleteByBlock(workspaceId, blockId)
    }
  }

  /**
   * Best-effort: kill the per-run container backing an execution. The container is
   * keyed by the execution id (see ContainerAgentExecutor), so the handle needs no
   * step lookup. A no-op for inline executors (no `stopJob`) and for an already-gone
   * container; never throws, so it can't derail the teardown that calls it.
   */
  private async stopRunContainer(workspaceId: string, executionId: string): Promise<void> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor) || !executor.stopJob) return
    try {
      await executor.stopJob({ jobId: executionId, workspaceId })
    } catch {
      // The container may already be gone (eviction/completion) — nothing to reclaim.
    }
  }
}

/** Whether a Tester report raised any concern serious enough to block a release. */
function hasBlockingConcerns(report: TestReport): boolean {
  return report.concerns.some((c) => c.severity === 'high' || c.severity === 'critical')
}

/**
 * The engine's release verdict for a Tester report: greenlit only when the Tester
 * said so AND it raised no blocking (high/critical) concern. Defensive against a
 * harness that greenlights with open blockers — low/medium concerns are advisory
 * and do not, on their own, withhold the greenlight or loop the fixer.
 */
function isGreenlit(report: TestReport): boolean {
  return report.greenlight === true && !hasBlockingConcerns(report)
}

/** One-line, human-readable summary of a Tester report's concerns, for failure messages. */
function describeTestConcerns(report: TestReport): string {
  if (!report.concerns.length) return report.summary || 'No greenlight given.'
  const names = report.concerns
    .map((c) => `${c.title} (${c.severity})`)
    .slice(0, 5)
    .join(', ')
  return `Concerns: ${names}${report.concerns.length > 5 ? ', …' : ''}`
}

/** Render a Tester report as the resolved-context block handed to the fixer. */
function renderReportForFixer(report: TestReport): string {
  const lines = ['Tester report — fix the concerns below, then the tester will re-run.', '']
  if (report.summary) lines.push(report.summary, '')
  if (report.concerns.length) {
    lines.push('Concerns to fix:')
    for (const c of report.concerns) lines.push(`- [${c.severity}] ${c.title}: ${c.detail}`)
    lines.push('')
  }
  const failed = report.outcomes.filter((o) => o.status === 'failed')
  if (failed.length) {
    lines.push('Failed checks:')
    for (const o of failed) lines.push(`- ${o.name}${o.detail ? `: ${o.detail}` : ''}`)
  }
  return lines.join('\n').trim()
}
