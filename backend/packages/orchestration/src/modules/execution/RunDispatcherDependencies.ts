import type {
  AgentExecutor,
  Block,
  BlockRepository,
  BrainstormSession,
  ClarityReview,
  Clock,
  ExecutionEventPublisher,
  ExecutionRepository,
  GateOutcomeRepository,
  GateRegistry,
  IdGenerator,
  IssueWritebackProvider,
  EnvironmentInvestigator,
  JudgeAssessor,
  JudgeRegistry,
  Logger,
  OperationalMetrics,
  ProviderCapabilities,
  ProviderRegistry,
  RequirementConcernLevel,
  RequirementReview,
  ResolveRunRepoContext,
  RunAutonomy,
  RunInitiatorScope,
  StepGating,
  StepResolverRegistry,
  TicketTrackerProvider,
  WorkRunner,
} from '@cat-factory/kernel'
import { GateOutcomeRecorder } from '../observability/GateOutcomeRecorder.js'
import { FollowUpGateController } from './FollowUpGateController.js'
import type { FollowUpGateControllerDeps } from './FollowUpGateController.js'
import type { SettledGate } from '../observability/GateOutcomeRecorder.js'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type {
  BugIntakeService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
} from '@cat-factory/integrations'
import type { SpendService } from '@cat-factory/spend'
import type { AgentContextBuilder, FragmentBodyResolver } from './AgentContextBuilder.js'
import type { CompanionController } from './CompanionController.js'
import type { BinaryCandidateController } from './BinaryCandidateController.js'
import type { ForkDecisionController } from './ForkDecisionController.js'
import type { HumanTestController } from './HumanTestController.js'
import type { InterviewGateController } from './InterviewGateController.js'
import type { MergeResolver } from './MergeResolver.js'
import type { PrReviewController } from './PrReviewController.js'
import type { PrVerificationReportController } from './PrVerificationReportController.js'
import type { RalphController } from './RalphController.js'
import type { ReviewGateController, ReviewKind } from './ReviewGateController.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { RunPolicyScope } from './policy-types.js'
import type { StepGraph } from './StepGraph.js'
import type { TesterController } from './TesterController.js'
import type { VisualConfirmationController } from './VisualConfirmationController.js'
import type { BlueprintReconciler } from './ExecutionService.js'
import type { InitiativeService } from '../initiative/InitiativeService.js'
import type { NotificationService } from '../notifications/NotificationService.js'

// The `RunDispatcher`'s dependency DECLARATIONS, split out of `RunDispatcher.ts` so that module
// carries the state machine rather than ~140 lines of interface, exactly as
// `ExecutionServiceDependencies.ts` was. Both members are re-exported from `RunDispatcher.ts`,
// so every existing import site is unaffected.

export /**
 * The task's fully-resolved merge-threshold preset (block pin → workspace default →
 * built-in). The dispatcher only reads the gate-relevant fields; the full shape is kept so
 * a gate's `attemptBudget(preset)` sees every knob. Mirrors {@link ExecutionService.resolveRiskPolicy}.
 */
type ResolvedRiskPolicy = {
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  judgeMinScore: number
  judgeMaxBounces: number
  releaseWatchWindowMinutes: number
  releaseMaxAttempts: number
  humanReviewGraceMinutes: number
  forkDecision?: StepGating | null
  /** Whether the run answers its own automatic-loop caps (the follow-up gate reads it). */
  autonomy?: RunAutonomy
}

/** Collaborators + leaf dependencies the {@link RunDispatcher} needs. */
export interface RunDispatcherDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  agentExecutor: AgentExecutor
  /** App-owned agent-kind registry: a registered kind's step spec + pre/post-op hooks. */
  agentKindRegistry: AgentKindRegistry
  /** App-owned polling-gate registry (built-ins installed by the facade via `registerBuiltinGates`). */
  gateRegistry: GateRegistry
  /**
   * The app-owned JUDGE registry (the fourth step-taxonomy bucket) the composition root
   * injected, plus the verdict producer. An absent / disabled assessor makes every judge step
   * a pass-through, which is exactly what a deployment with no model wired (and the
   * conformance/e2e suites) gets. See `docs/initiatives/judge-registry.md`.
   */
  judgeRegistry: JudgeRegistry
  judgeAssessor?: JudgeAssessor
  /**
   * The inline diagnosis behind the deployer's environment-investigation loop. Absent (no model
   * provider / no routing default) ⇒ a provisioning failure no checkout edit can address stays
   * terminal and unexplained, exactly as before the loop existed.
   */
  environmentInvestigator?: EnvironmentInvestigator
  /**
   * The prompt-fragment library, used by the judge driver for ONE thing: resolving a rubric's
   * per-workspace override body (see `JudgeRubric.fragmentId`). Absent ⇒ the registration's
   * default rubric.
   */
  fragmentResolver?: FragmentBodyResolver
  /** App-owned step-completion-resolver registry (deployment-registered resolvers). */
  stepResolverRegistry: StepResolverRegistry
  /** App-owned provider registry the gate machine's {@link GateContext} reads (gate data sources). */
  providerRegistry: ProviderRegistry
  workRunner: WorkRunner
  events: ExecutionEventPublisher
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Where the dispatcher's best-effort hooks (issue writeback, lease release, repo ops) report
   * their drops. Absent ⇒ `noopLogger`, which is what the engine unit tests construct with.
   */
  logger?: Logger
  /**
   * The deployment-wide counter port. Required, not optional: an un-wired counter reports zero
   * forever, which is indistinguishable from the signal genuinely never firing. A caller with
   * nothing to export passes kernel's `noopOperationalMetrics`, which says so in code.
   */
  operationalMetrics: OperationalMetrics
  /**
   * Optional settled-gate projection: the gate machine records each terminal verdict into it
   * for the operator dashboard's attempt statistics. Absent ⇒ nothing is recorded.
   */
  gateOutcomeRepository?: GateOutcomeRepository
  spend: SpendService
  stepGraph: StepGraph
  runStateMachine: RunStateMachine
  contextBuilder: AgentContextBuilder
  mergeResolver: MergeResolver
  companionController: CompanionController
  testerController: TesterController
  ralphController: RalphController
  humanTestController: HumanTestController
  visualConfirmationController: VisualConfirmationController
  reviewGate: ReviewGateController
  forkDecisionController: ForkDecisionController
  binaryCandidateController: BinaryCandidateController
  prReviewController: PrReviewController
  requirementsKind: ReviewKind<RequirementReview>
  clarityKind: ReviewKind<ClarityReview>
  requirementsBrainstormKind: ReviewKind<BrainstormSession>
  architectureBrainstormKind: ReviewKind<BrainstormSession>
  /**
   * The interactive-interviewer gates wired for this deployment (initiative-planning, document
   * interview, …). Each rides the shared {@link InterviewGateController} spine and is routed by
   * the `interview-gate` TRAIT, keyed on its own `agentKind` — so adding a new interviewer wires
   * its controller here, with no new dispatch branch. Absent/unwired kinds pass through.
   */
  interviewControllers?: InterviewGateController<unknown>[]
  /** Keeps the run's verification report current on its PR; a no-op with no publisher wired. */
  prVerificationReport: PrVerificationReportController
  runInitiatorScope: RunInitiatorScope
  environmentProvisioning?: EnvironmentProvisioningService
  /**
   * Reclaims (and confirms the reclaim of) provisioned environments — what the `disposer` step
   * drives. Absent ⇒ a disposer records that there was nothing to reclaim, which is the truth
   * for a deployment whose environment integration is unwired.
   */
  environmentTeardown?: EnvironmentTeardownService
  ticketTrackerProvider?: TicketTrackerProvider
  issueWriteback?: IssueWritebackProvider
  /** The recurring `bug-intake` step's read-and-claim helper; absent → the step is a no-op. */
  bugIntakeService?: BugIntakeService
  notificationService?: NotificationService
  blueprintReconciler?: BlueprintReconciler
  initiativeService?: InitiativeService
  resolveRunRepoContext?: ResolveRunRepoContext
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
    modelPresetId?: string,
  ) => Promise<ProviderCapabilities>
  /** Resolve a task's merge preset (stays on the engine, shared with the merge subgraph). */
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ) => Promise<ResolvedRiskPolicy>
  /** Whether a resolved model id incurs metered monetary cost (the start gate's predicate). */
  modelIdIsMetered: (id: string | undefined, caps: ProviderCapabilities) => boolean
}

/**
 * The `recordGateOutcome` callback both gate-settling controllers take, or nothing when no
 * projection is wired.
 *
 * Computed ONCE and spread into both: a gate reaches a terminal verdict down two paths, the
 * precheck/exhaustion machine in {@link GateStepController} and the investigate-don't-fix
 * completion in {@link PollRunningController}, and wiring only the first is why the
 * `post-release-health` gate was absent from the statistics entirely. Two call sites, one
 * recorder, so a third settling path has one obvious thing to reach for.
 *
 * A free function rather than an inline branch in the constructor: each controller takes ONE
 * bound callback and must stay independent of the sink's collaborators, and the constructor is
 * already at its statement budget (budgets are split triggers). It lives beside the deps it
 * `Pick`s from, so the dispatcher imports it rather than re-declaring that slice.
 */
export function gateOutcomeRecording(
  deps: Pick<RunDispatcherDeps, 'gateOutcomeRepository' | 'clock'>,
  logger: Logger,
): { recordGateOutcome?: (settled: SettledGate) => Promise<void> } {
  if (!deps.gateOutcomeRepository) return {}
  const recorder = new GateOutcomeRecorder({
    gateOutcomeRepository: deps.gateOutcomeRepository,
    now: () => deps.clock.now(),
    logger,
  })
  return { recordGateOutcome: (settled) => recorder.record(settled) }
}

/**
 * Build the Follow-up companion gate from the dispatcher's deps.
 *
 * A free function for the reason {@link gateOutcomeRecording} is one: the constructor is at its
 * per-function line budget, and a budget is a split trigger rather than a number to raise. This
 * controller's field spread is the largest of the constructor's remaining literals and the one
 * that grew, so it is the one that moves.
 *
 * `resolveRiskPolicy` stays a bound callback the caller passes in: the gate reads the policy for
 * exactly one decision (whether undecided items park for a person or are dismissed unattended),
 * and taking the resolver by reference keeps it independent of how the dispatcher resolves one.
 */
export function buildFollowUpGate(
  deps: RunDispatcherDeps,
  resolveRiskPolicy: FollowUpGateControllerDeps['resolveRiskPolicy'],
): FollowUpGateController {
  return new FollowUpGateController({
    executionRepository: deps.executionRepository,
    blockRepository: deps.blockRepository,
    contextBuilder: deps.contextBuilder,
    stepGraph: deps.stepGraph,
    runStateMachine: deps.runStateMachine,
    workRunner: deps.workRunner,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    notificationService: deps.notificationService,
    ticketTrackerProvider: deps.ticketTrackerProvider,
    resolveRiskPolicy,
    logger: deps.logger,
    operationalMetrics: deps.operationalMetrics,
  })
}
