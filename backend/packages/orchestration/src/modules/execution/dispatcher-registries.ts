import type {
  AgentRunContext,
  AgentRunResult,
  Block,
  BlockRepository,
  BrainstormSession,
  ClarityReview,
  Clock,
  ExecutionInstance,
  ForkProposal,
  GateDefinition,
  JudgeDefinition,
  PipelineStep,
  BugFishingAgentOutput,
  PrReviewAgentOutput,
  PrReviewChallengeOutput,
  RequirementReview,
  ResolverContext,
  RunInitiatorScope,
  StepCompletionResolver,
  StepResolverRegistry,
  TaskEstimateBasis,
} from '@cat-factory/kernel'
import {
  INITIATIVE_ANALYST_AGENT_KIND,
  INITIATIVE_COMMITTER_AGENT_KIND,
  INITIATIVE_PLANNER_AGENT_KIND,
} from '@cat-factory/kernel'
import {
  CHALLENGE_INVESTIGATOR_KIND,
  FORK_PROPOSER_KIND,
  PR_REVIEWER_KIND,
  renderBugFishingPhaseBrief,
  hasTrait,
  isCompanionKind,
  isContainerBackedCompanion,
  INTERVIEW_GATE_TRAIT,
  TASK_ESTIMATOR_AGENT_KIND,
  TASK_REASSESSOR_AGENT_KIND,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  DEPLOYER_AGENT_KIND,
  DISPOSER_AGENT_KIND,
  isDeployStep,
  isDisposeStep,
} from '@cat-factory/integrations'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import { BUG_INTAKE_AGENT_KIND } from '../pipelines/pipelineShape.js'
import { renderInitiativePlanForReview } from '@cat-factory/contracts'
import {
  coerceTaskEstimate,
  reviseTaskEstimate,
  summarizeEstimate,
} from '../estimation/estimate.logic.js'
import { renderInvestigationDigest } from './bugInvestigation.logic.js'
import { renderReproDigest } from './reproTest.logic.js'
import {
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  BLUEPRINTS_AGENT_KIND,
  BUG_INVESTIGATOR_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  HUMAN_TEST_AGENT_KIND,
  isTesterKind,
  MERGER_AGENT_KIND,
  REPRO_TEST_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  TRACKER_AGENT_KIND,
  VISUAL_CONFIRM_AGENT_KIND,
} from './ci.logic.js'
import type { DeployerStepController } from './DeployerStepController.js'
import type { DisposerStepController } from './DisposerStepController.js'
import type { CompanionController } from './CompanionController.js'
import type { HumanTestController } from './HumanTestController.js'
import type { MergeResolver } from './MergeResolver.js'
import type { ReviewGateController, ReviewKind } from './ReviewGateController.js'
import type { BinaryCandidateController } from './BinaryCandidateController.js'
import type { ForkDecisionController } from './ForkDecisionController.js'
import { PrReviewController, PR_REVIEW_STEP_KIND } from './PrReviewController.js'
import { BugFishingController, BUG_FISHING_STEP_KIND } from './BugFishingController.js'
import {
  describeRecordedPhase,
  priorBugFishingFindingTitles,
  startBugFishingPhase,
} from './bugFishing.logic.js'
import { forkPhasePending, resolveForkTriState } from './forkDecision.logic.js'
import type { InterviewGateController } from './InterviewGateController.js'
import type { TesterController } from './TesterController.js'
import type { RalphController } from './RalphController.js'
import { isRalphKind } from './ralph.logic.js'
import type { VisualConfirmationController } from './VisualConfirmationController.js'
import {
  FALLTHROUGH_STEP_HANDLER_ORDER,
  type StepCompletionInterceptor,
  type StepHandler,
  type StepHandlerContext,
} from './step-handler-registry.js'
import type { AdvanceResult } from './advance.js'
import type { InitiativeService } from '../initiative/InitiativeService.js'

/**
 * The inline review/brainstorm gate kinds, all driven through the {@link ReviewGateController}
 * by the dispatcher's `review-gate` StepHandler. Kept in sync with the handler's `switch`.
 */
const REVIEW_GATE_AGENT_KINDS: ReadonlySet<string> = new Set([
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
])

/**
 * The engine seams the three built-in dispatch registries (step handlers, completion
 * interceptors, post-completion / terminal resolvers) close over. `RunDispatcher` builds one of
 * these from its own collaborators + bound methods and hands it to the builders below, so the
 * (large, declarative) registry construction lives outside the dispatcher class while still
 * resolving everything at call time. No behaviour changes in the move.
 */
export interface DispatcherRegistryDeps {
  // Leaf collaborators the built-in handlers/interceptors/resolvers reach into.
  blockRepository: BlockRepository
  clock: Clock
  agentKindRegistry: AgentKindRegistry
  stepResolverRegistry: StepResolverRegistry
  runInitiatorScope: RunInitiatorScope
  environmentProvisioning?: EnvironmentProvisioningService
  initiativeService?: InitiativeService
  deployer: DeployerStepController
  disposer: DisposerStepController
  companionController: CompanionController
  testerController: TesterController
  ralphController: RalphController
  humanTestController: HumanTestController
  visualConfirmationController: VisualConfirmationController
  reviewGate: ReviewGateController
  forkDecisionController: ForkDecisionController
  binaryCandidateController: BinaryCandidateController
  prReviewController: PrReviewController
  bugFishingController: BugFishingController
  mergeResolver: MergeResolver
  requirementsKind: ReviewKind<RequirementReview>
  clarityKind: ReviewKind<ClarityReview>
  requirementsBrainstormKind: ReviewKind<BrainstormSession>
  architectureBrainstormKind: ReviewKind<BrainstormSession>
  interviewControllers: Map<string, InterviewGateController<unknown>>
  // Dispatcher methods the closures call back into (bound at construction).
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
  runTracker: (
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ) => Promise<AgentRunResult>
  runBugIntake: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ) => Promise<AdvanceResult>
  runInitiativeCommitter: (
    workspaceId: string,
    block: Block,
  ) => Promise<{ kind: 'ok'; result: AgentRunResult } | { kind: 'failed'; error: string }>
  evaluateGate: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    gate: GateDefinition,
  ) => Promise<AdvanceResult>
  gateFor: (agentKind: string) => GateDefinition | undefined
  evaluateJudge: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    judge: JudgeDefinition,
  ) => Promise<AdvanceResult>
  judgeFor: (agentKind: string) => JudgeDefinition | undefined
  handleForkDecisionPhase: (ctx: StepHandlerContext) => Promise<AdvanceResult>
  handlePrReviewResolution: (ctx: StepHandlerContext) => Promise<AdvanceResult>
  handleAgentStep: (
    ctx: StepHandlerContext,
    dispatchKind?: string,
    augmentContext?: (context: AgentRunContext) => void,
  ) => Promise<AdvanceResult>
  ingestBlueprint: (workspaceId: string, blockId: string, rawService: unknown) => Promise<void>
  ingestSpec: (workspaceId: string, rawDoc: unknown) => Promise<void>
}

/**
 * The two ENVIRONMENT-LIFECYCLE step handlers, extracted as a pair because they are one concern
 * from opposite ends: the `deployer` stands the run's throwaway infrastructure up and the
 * `disposer` reclaims it. Split out of {@link buildStepHandlerRegistry} when adding the disposer
 * pushed that function past its line budget — the budget is a split trigger, not a number to
 * raise, and these two are the cohesive slice to lift.
 */
function buildEnvironmentLifecycleHandlers(d: DispatcherRegistryDeps): StepHandler[] {
  return [
    // A `deployer` step provisions an ephemeral environment deterministically via the
    // provider — no LLM, no token usage — when the integration is wired. Unwired, its
    // `canHandle` is false so the step falls through to the generic agent path.
    {
      kind: DEPLOYER_AGENT_KIND,
      order: 100,
      canHandle: ({ step }) => !!d.environmentProvisioning && isDeployStep(step.agentKind),
      handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
        d.deployer.runDeployerStep(workspaceId, instance, step, block, isFinalStep),
    },
    // A `disposer` step reclaims the ephemeral environments THIS RUN stood up, at the point in
    // the pipeline its author put it — the deployer's counterpart, and the only thing that can
    // close a run's own "environment up → evidence → torn down" proof while the run is still
    // alive (the TTL sweep fires long after it settled). Always claims the step: when the
    // environment integration is unwired it records "nothing to reclaim", which is exactly what
    // a deployment that provisioned nothing should say — where falling through to the generic
    // agent path would dispatch a container for a kind that has no prompt.
    {
      kind: DISPOSER_AGENT_KIND,
      order: 105,
      canHandle: ({ step }) => isDisposeStep(step.agentKind),
      handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
        d.disposer.runDisposerStep(workspaceId, instance, step, block, isFinalStep),
    },
  ]
}

/**
 * Build the order-sorted per-step-kind handler list (built-ins constructed inline, closing over
 * the injected {@link DispatcherRegistryDeps}). Engine-internal: there is no public
 * `registerStepHandler` seam. Phase 0 registers only the generic fallthrough; later phases
 * prepend more-specific handlers with lower `order`.
 */
export function buildStepHandlerRegistry(d: DispatcherRegistryDeps): StepHandler[] {
  const handlers: StepHandler[] = [
    ...buildEnvironmentLifecycleHandlers(d),
    // A `tracker` step files a GitHub issue / Jira ticket from the preceding `analysis`
    // output (the tech-debt pipeline) — no LLM of its own. It is a pass-through when no
    // tracker provider is wired or none is configured for the workspace (handled inside
    // {@link runTracker}, which still records a result), so it always claims the step.
    {
      kind: TRACKER_AGENT_KIND,
      order: 110,
      canHandle: ({ step }) => step.agentKind === TRACKER_AGENT_KIND,
      handle: async ({ workspaceId, instance, step, block, isFinalStep }) => {
        const result = await d.runTracker(workspaceId, instance, block)
        return d.recordStepResult(workspaceId, instance, step, isFinalStep, result)
      },
    },
    // A `bug-intake` step (the recurring bug-triage pipeline) pulls ONE matching open issue from
    // the schedule's tracker board, claims it, and seeds the reused block from it — no LLM of its
    // own, the inbound dual of `tracker`. On no match (or no task source wired) it completes the
    // run successfully, skipping every remaining step. Handled entirely inside
    // {@link runBugIntake}, so it always claims the step.
    {
      kind: BUG_INTAKE_AGENT_KIND,
      order: 111,
      canHandle: ({ step }) => step.agentKind === BUG_INTAKE_AGENT_KIND,
      handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
        d.runBugIntake(workspaceId, instance, step, block, isFinalStep),
    },
    // The interactive-INTERVIEWER gates (`initiative-interviewer`, `doc-interviewer`, …): an
    // inline LLM gate that PARKS the run on a decision-wait while the human answers the
    // interviewer's questions through a dedicated window, then synthesizes a brief and advances
    // (see {@link InterviewGateController}). Routed by the `interview-gate` TRAIT — the same
    // marker the re-park + approval guards key off — and dispatched to the controller registered
    // for the step's `agentKind`, so a new interviewer just carries the trait + wires its
    // controller (no new branch here). Pass-through when the interviewer isn't wired (no model /
    // no store) so pipelines + conformance run unchanged; a wired-but-unmatched trait kind is a
    // pipeline authoring error, but we still advance rather than wedge the run.
    {
      kind: 'interview-gate',
      order: 113,
      canHandle: ({ step }) => hasTrait(step.agentKind, INTERVIEW_GATE_TRAIT, d.agentKindRegistry),
      handle: ({ workspaceId, instance, step, block, isFinalStep }) => {
        const controller = d.interviewControllers.get(step.agentKind)
        return controller
          ? controller.evaluate(workspaceId, instance, step, block, isFinalStep)
          : d.recordStepResult(workspaceId, instance, step, isFinalStep, { output: '' })
      },
    },
    // The `initiative-committer` step persists an APPROVED initiative plan: it runs
    // strictly after the planner's human gate, flips the entity to `executing`, and
    // mirrors the tracker into the repo (`docs/initiatives/<slug>/`) when GitHub is
    // wired — no LLM of its own (the `tracker`-style deterministic one-shot).
    {
      kind: INITIATIVE_COMMITTER_AGENT_KIND,
      order: 115,
      canHandle: ({ step }) => step.agentKind === INITIATIVE_COMMITTER_AGENT_KIND,
      handle: async ({ workspaceId, instance, step, block, isFinalStep }) => {
        const outcome = await d.runInitiativeCommitter(workspaceId, block)
        if (outcome.kind === 'failed') {
          return { kind: 'job_failed', error: outcome.error, failureKind: 'agent' }
        }
        return d.recordStepResult(workspaceId, instance, step, isFinalStep, outcome.result)
      },
    },
    // The `requirements-review` / `clarity-review` / `requirements-brainstorm` /
    // `architecture-brainstorm` steps are inline reviewers that park for their dedicated
    // window and drive the iterative answer → incorporate → re-review loop — NOT
    // container/prose agents. All four run through the {@link ReviewGateController},
    // parameterised by their {@link ReviewKind} (the per-case `switch` binds each kind's
    // review type so `evaluate`'s generic infers). Pass-through when the service isn't wired.
    {
      kind: 'review-gate',
      order: 120,
      canHandle: ({ step }) => REVIEW_GATE_AGENT_KINDS.has(step.agentKind),
      handle: ({ workspaceId, instance, step, block, isFinalStep }) => {
        switch (step.agentKind) {
          case REQUIREMENTS_REVIEW_AGENT_KIND:
            return d.reviewGate.evaluate(
              d.requirementsKind,
              workspaceId,
              instance,
              step,
              block,
              isFinalStep,
            )
          case CLARITY_REVIEW_AGENT_KIND:
            return d.reviewGate.evaluate(
              d.clarityKind,
              workspaceId,
              instance,
              step,
              block,
              isFinalStep,
            )
          case REQUIREMENTS_BRAINSTORM_AGENT_KIND:
            return d.reviewGate.evaluate(
              d.requirementsBrainstormKind,
              workspaceId,
              instance,
              step,
              block,
              isFinalStep,
            )
          case ARCHITECTURE_BRAINSTORM_AGENT_KIND:
            return d.reviewGate.evaluate(
              d.architectureBrainstormKind,
              workspaceId,
              instance,
              step,
              block,
              isFinalStep,
            )
          // `canHandle` admits only the kinds in REVIEW_GATE_AGENT_KINDS, so every member
          // must have an explicit case above. Throw loudly if the two ever drift (a new
          // review kind added to the Set without a case here) rather than silently routing
          // it to the wrong reviewer.
          default:
            throw new Error(`Unhandled review-gate agentKind "${step.agentKind}"`)
        }
      },
    },
    // A `human-test` gate spins up an ephemeral environment and PARKS for a human to
    // validate the change in a live URL — NOT a container/prose agent and NOT a
    // programmatic polling gate (the human is the verdict). Degrades to a manual (no-env)
    // mode when no ephemeral-environment provider is wired. See {@link HumanTestController}.
    {
      kind: HUMAN_TEST_AGENT_KIND,
      order: 130,
      canHandle: ({ step }) => step.agentKind === HUMAN_TEST_AGENT_KIND,
      handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
        d.humanTestController.evaluate(workspaceId, instance, step, block, isFinalStep),
    },
    // A `visual-confirmation` gate gathers the UI tester's screenshots + uploaded reference
    // designs and PARKS for a human to review actual-vs-reference, then on demand dispatches
    // the Tester's `fixer`. Passes through when no binary-artifact store is wired.
    // See {@link VisualConfirmationController}.
    {
      kind: VISUAL_CONFIRM_AGENT_KIND,
      order: 140,
      canHandle: ({ step }) => step.agentKind === VISUAL_CONFIRM_AGENT_KIND,
      handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
        d.visualConfirmationController.evaluate(workspaceId, instance, step, block, isFinalStep),
    },
    // A polling gate step (`ci` / `conflicts` / `post-release-health` / `human-review`) runs
    // a programmatic precheck and only escalates to a helper container agent on a negative
    // verdict — no LLM of its own. Pass-through when the gate's provider is not wired. One
    // generic machine drives every gate; see {@link evaluateGate}. `canHandle` is the gate
    // registry lookup, so this claims exactly the registered gate kinds.
    {
      kind: 'polling-gate',
      order: 150,
      canHandle: ({ step }) => d.gateFor(step.agentKind) !== undefined,
      handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
        d.evaluateGate(workspaceId, instance, step, block, isFinalStep, d.gateFor(step.agentKind)!),
    },
    // A JUDGE step (the fourth step-taxonomy bucket) runs an LLM assessment of the run's work
    // against a registered RUBRIC, compares the verdict's score to the task's merge-preset
    // threshold, and advances / parks / bounces the producing step / fails the run. Pass-through
    // when no assessment model is wired. One generic machine drives every judge; see
    // {@link JudgeStepController.evaluate}. `canHandle` is the judge-registry lookup, so this
    // claims exactly the registered judge kinds — and it sits BESIDE the gate handler because the
    // two registries are disjoint by construction (a kind is a gate or a judge, never both).
    {
      kind: 'judge',
      order: 155,
      canHandle: ({ step }) => d.judgeFor(step.agentKind) !== undefined,
      handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
        d.evaluateJudge(
          workspaceId,
          instance,
          step,
          block,
          isFinalStep,
          d.judgeFor(step.agentKind)!,
        ),
    },
    // An INLINE companion (architect-companion / spec-companion) grades the nearest
    // preceding producer right here and loops it back for automatic rework below the
    // threshold before any human gate. CONTAINER-backed companions (reviewer / doc-reviewer)
    // do NOT match — they fall through to the generic async container dispatch and have their
    // verdict resolved by the completion interceptor instead. See {@link CompanionController}.
    {
      kind: 'inline-companion',
      order: 160,
      canHandle: ({ step }) =>
        isCompanionKind(step.agentKind, d.agentKindRegistry) &&
        !isContainerBackedCompanion(step.agentKind, d.agentKindRegistry),
      handle: ({ workspaceId, instance, step, block, isFinalStep, options }) =>
        d.companionController.evaluate(workspaceId, instance, step, block, isFinalStep, options),
    },
    // The optional implementation-fork decision phase on a Coder step (Phase A): when the
    // per-task tri-state + the risk-policy gate call for it, dispatch the read-only
    // `fork-proposer` explore job as a helper off THIS coder step. Claims the step only
    // while the phase is pending (tri-state not `off`, not yet resolved); once resolved
    // (`chosen` / `single_path` / `skipped`) it falls through so the Coder dispatches
    // normally (Phase B). A parked `awaiting_choice` step is short-circuited by the
    // run-lifecycle re-entry guard before this handler runs. See {@link handleForkDecisionPhase}.
    {
      kind: 'fork-decision',
      order: 170,
      canHandle: ({ step, block }) =>
        forkPhasePending(step, resolveForkTriState(block.agentConfig)),
      handle: (ctx) => d.handleForkDecisionPhase(ctx),
    },
    // The PR deep-review RESOLUTION / CHALLENGE phase: after the human resolved a parked review
    // with `fix` / `post`, or CHALLENGED a finding, `PrReviewController` re-armed this
    // `pr-reviewer` step and woke the driver. Claim it by the re-armed status so it re-dispatches
    // as the Fixer (`fixing`), posts the selected findings as inline PR comments (`posting`), or
    // dispatches the Challenge Investigator against the challenged finding (`challenging`) — never
    // the generic pr-reviewer clone the fallthrough would run. A `reviewing`/`awaiting_selection`/
    // resolved step falls through (this handler doesn't claim it). See {@link handlePrReviewResolution}.
    {
      kind: 'pr-review-resolution',
      order: 175,
      canHandle: ({ step }) =>
        step.agentKind === PR_REVIEW_STEP_KIND &&
        (step.prReview?.status === 'fixing' ||
          step.prReview?.status === 'posting' ||
          step.prReview?.status === 'challenging'),
      handle: (ctx) => d.handlePrReviewResolution(ctx),
    },
    // A BUG-FISHING EXPEDITION pass. The step is dispatched once per ANGLE rather than once per
    // run, so this handler owns what differs between those dispatches: it seeds the expedition on
    // first entry (planning the angles from the task's selection), marks the angle now being
    // fished, and folds that angle's BRIEF into the dispatch as a prior output — the same
    // injection point the Challenge Investigator's brief uses. Everything else is the ordinary
    // container dispatch, so it delegates to `handleAgentStep` rather than reimplementing it.
    {
      kind: 'bug-fishing-phase',
      order: 178,
      canHandle: ({ step }) => step.agentKind === BUG_FISHING_STEP_KIND,
      handle: (ctx) => handleBugFishingPhase(d, ctx),
    },
    // The generic container/inline-agent step — claims every step no more-specific handler
    // did. Highest order so it always runs last. See {@link handleAgentStep}.
    {
      kind: 'agent',
      order: FALLTHROUGH_STEP_HANDLER_ORDER,
      canHandle: () => true,
      handle: (ctx) => d.handleAgentStep(ctx),
    },
  ]
  return handlers.sort((a, b) => a.order - b.order)
}

/**
 * Dispatch ONE angle of a bug-fishing expedition.
 *
 * Three things happen before the ordinary container dispatch, and each is here rather than in the
 * controller because each is about THIS dispatch rather than about the expedition's record:
 *
 * 1. The expedition is planned on first entry (idempotent — a step that already carries one keeps
 *    it, which is what makes every later angle and every durable replay cheap).
 * 2. The angle now being fished is marked, so the window shows which pass is in flight rather
 *    than only which have finished.
 * 3. The angle's BRIEF is folded in as a prior output: what this pass is hunting, the task's own
 *    focus, and the titles earlier passes already reported so this one does not repeat them.
 *
 * A block that plans no angles at all settles the step as `skipped` and falls through to the
 * ordinary dispatch, which is the honest reading: there was nothing to fish, and parking a human
 * in front of an empty expedition would be worse than saying so.
 */
async function handleBugFishingPhase(
  d: DispatcherRegistryDeps,
  ctx: StepHandlerContext,
): Promise<AdvanceResult> {
  const { workspaceId, step, block } = ctx
  const planned = await d.bugFishingController.ensurePlanned(workspaceId, step, block)
  if (!planned) {
    step.bugFishing = { status: 'skipped', phases: [], currentPhaseIndex: 0, findings: [] }
    return d.handleAgentStep(ctx)
  }
  const phaseIndex = planned.currentPhaseIndex ?? 0
  const phase = (planned.phases ?? [])[phaseIndex]
  if (!phase) return d.handleAgentStep(ctx)
  step.bugFishing = startBugFishingPhase(planned, phaseIndex)
  const brief = renderBugFishingPhaseBrief({
    phase: describeRecordedPhase(phase),
    position: { index: phaseIndex + 1, total: (planned.phases ?? []).length },
    focus: block.taskTypeFields?.fishingFocus ?? null,
    priorFindingTitles: priorBugFishingFindingTitles(planned),
  })
  return d.handleAgentStep(ctx, undefined, (context) => {
    context.priorOutputs = [
      ...context.priorOutputs,
      { agentKind: BUG_FISHING_STEP_KIND, output: brief },
    ]
  })
}

/**
 * Build the order-sorted completion-path interceptors (companion / tester verdict
 * short-circuits), mirroring {@link buildStepHandlerRegistry}.
 */
export function buildStepCompletionInterceptors(
  d: DispatcherRegistryDeps,
): StepCompletionInterceptor[] {
  const interceptors: StepCompletionInterceptor[] = [
    // A container-backed companion (reviewer / doc-reviewer) just finished reviewing the
    // real repository on the producer's PR branch and returned its verdict as
    // `result.custom`. Hand it to the companion loop, which parses the verdict and applies
    // the SAME threshold / rework / human-gate handling an inline companion gets. Routed
    // here (not the normal step completion) so the verdict drives the loop instead of being
    // recorded as plain output. Falls through (returns null) when the block can't be loaded.
    {
      kind: 'companion-verdict',
      order: 100,
      canIntercept: ({ step }) =>
        isCompanionKind(step.agentKind, d.agentKindRegistry) &&
        isContainerBackedCompanion(step.agentKind, d.agentKindRegistry),
      intercept: async ({ workspaceId, instance, step, isFinalStep, result }) => {
        const companionBlock = await d.blockRepository.get(workspaceId, instance.blockId)
        if (!companionBlock) return null
        return d.companionController.resolveContainerVerdict(
          workspaceId,
          instance,
          step,
          companionBlock,
          isFinalStep,
          result,
        )
      },
    },
    // The `fork-proposer` explore job (Phase A of the fork decision) just finished on a
    // coder step. Its structured `result.custom` is the proposal; record it onto the step's
    // `forkDecision` and either park for the human to choose (≥2 usable forks) or auto-advance
    // a single path — never the normal output/PR/follow-up/approval completion (none applies
    // to the proposer). Keyed on the coder step carrying `forkDecision.status === 'proposing'`.
    {
      kind: 'fork-proposal',
      order: 105,
      canIntercept: ({ step }) =>
        step.agentKind === 'coder' && step.forkDecision?.status === 'proposing',
      intercept: ({ workspaceId, instance, step, result }) => {
        const proposal = d.agentKindRegistry
          .structuredOutput(FORK_PROPOSER_KIND)
          ?.safeParse(result.custom) as ForkProposal | undefined
        return d.forkDecisionController.recordProposal(
          workspaceId,
          instance,
          step,
          proposal,
          step.model,
        )
      },
    },
    // A BINARY-OUTPUT step configured to COMPARE candidates just finished its generating pass.
    // Its reply's fenced ```binary-candidates block is what it staged; record it and either park
    // for the human to choose (≥2 candidates), auto-keep the only one, or fall through to the
    // ordinary completion when nothing was staged (the run advances and the step's state names
    // the reason). Keyed on the step's own comparison config plus the ABSENCE of a resolved
    // choice, which is what tells the two passes of one step apart: after `keep` the same step
    // re-runs to deliver, and that pass must complete normally.
    {
      kind: 'binary-candidates',
      order: 107,
      canIntercept: ({ step }) =>
        step.stepOptions?.binaryOutput?.comparison !== undefined &&
        step.binaryCandidates?.status !== 'chosen' &&
        step.binaryCandidates?.status !== 'no_choice',
      intercept: ({ workspaceId, instance, step, result }) =>
        d.binaryCandidateController.recordCandidates(workspaceId, instance, step, result.output),
    },
    // A Challenge Investigator helper (dispatched off a parked `pr-reviewer` step when the human
    // challenged a finding) just finished. Its structured `result.custom` is the uphold/retract
    // verdict; apply it to the challenged finding and RE-PARK the review — never the normal
    // completion, nor the `pr-review` interceptor below (which would mis-parse the verdict as
    // findings). Keyed on the `pr-reviewer` step carrying `prReview.status === 'challenging'`, so
    // it wins over `pr-review` (higher order) only during a challenge; a replay after the marker
    // cleared returns null and falls through to `pr-review`'s idempotent re-park.
    {
      kind: 'pr-review-challenge',
      order: 104,
      canIntercept: ({ step }) =>
        step.agentKind === PR_REVIEW_STEP_KIND && step.prReview?.status === 'challenging',
      intercept: ({ workspaceId, instance, step, result }) => {
        const output = d.agentKindRegistry
          .structuredOutput(CHALLENGE_INVESTIGATOR_KIND)
          ?.safeParse(result.custom) as PrReviewChallengeOutput | undefined
        return d.prReviewController.recordChallengeResult(workspaceId, instance, step, output)
      },
    },
    // The read-only `pr-reviewer` deep-review job just finished on a review task's step. Its
    // structured `result.custom` is the sliced, prioritized findings; record them onto the
    // step's `prReview` and PARK for the human to select which findings matter (≥1 finding),
    // rather than the normal completion. A clean PR (no findings) returns null and falls
    // through to the normal finish. Keyed on the `pr-reviewer` step kind.
    {
      kind: 'pr-review',
      order: 106,
      canIntercept: ({ step }) => step.agentKind === PR_REVIEW_STEP_KIND,
      intercept: async ({ workspaceId, instance, step, result }) => {
        const output = d.agentKindRegistry
          .structuredOutput(PR_REVIEWER_KIND)
          ?.safeParse(result.custom) as PrReviewAgentOutput | undefined
        const block = await d.blockRepository.get(workspaceId, instance.blockId)
        return d.prReviewController.recordFindings(
          workspaceId,
          instance,
          step,
          output,
          result.model ?? step.model,
          block,
        )
      },
    },
    // A BUG-FISHING pass finished. Its structured `result.custom` is that ONE angle's catch:
    // stamp the findings onto the step's `bugFishing` and either re-arm the step for the next
    // angle or park the run for triage — never the normal single-shot completion, which would
    // end the expedition after its first pass. Keyed on the `bug-fisher` step kind; a step whose
    // expedition has already settled returns null and falls through.
    {
      kind: 'bug-fishing',
      order: 108,
      canIntercept: ({ step }) => step.agentKind === BUG_FISHING_STEP_KIND,
      intercept: async ({ workspaceId, instance, step, result }) => {
        const output = d.agentKindRegistry
          .structuredOutput(BUG_FISHING_STEP_KIND)
          ?.safeParse(result.custom) as BugFishingAgentOutput | undefined
        const block = await d.blockRepository.get(workspaceId, instance.blockId)
        return d.bugFishingController.recordPhaseResult(
          workspaceId,
          instance,
          step,
          output,
          result.model ?? step.model,
          block,
        )
      },
    },
    // A `tester` step returned a structured report. On a withheld greenlight we do NOT
    // finish the step: loop the `fixer` (within the attempt budget) and re-test, mirroring
    // the CI gate. A greenlight (or no provider) returns null and falls through to the
    // normal finish/advance below. Records the report on the step either way.
    {
      kind: 'tester-verdict',
      order: 110,
      canIntercept: ({ step, result }) =>
        isTesterKind(step.agentKind) && result.testReport !== undefined,
      intercept: ({ workspaceId, instance, step, result }) =>
        d.testerController.resolveTesterResult(workspaceId, instance, step, result),
    },
    // A `ralph` iteration finished and the harness attached its programmatic validation
    // verdict. Hand it to the ralph loop: a passing command finishes + advances (returns
    // null → normal completion), a failing one re-dispatches a fresh iteration within the
    // budget or gives up for a human — never the normal single-shot completion. Keyed on the
    // `ralph` kind carrying a `ralphVerdict`; a ralph run that errored before validation (no
    // verdict) falls through to the normal failure path.
    {
      kind: 'ralph-verdict',
      order: 115,
      canIntercept: ({ step, result }) =>
        isRalphKind(step.agentKind) && result.ralphVerdict !== undefined,
      intercept: ({ workspaceId, instance, step, result }) =>
        d.ralphController.resolveRalphResult(workspaceId, instance, step, result),
    },
  ]
  return interceptors.sort((a, b) => a.order - b.order)
}

/**
 * Build the post-completion / terminal step-resolver registry, keyed by `agentKind`. The
 * built-in `merger` resolver (which owns terminal status) plus the post-completion result
 * reshapers are constructed inline; deployment-registered resolvers are merged last (last
 * registration wins).
 */
export function buildStepResolverRegistry(
  d: DispatcherRegistryDeps,
): Map<string, StepCompletionResolver> {
  const resolvers: StepCompletionResolver[] = [
    // The `merger` agent OWNS the merge decision, but the merge itself is mechanical
    // and uses backend-held GitHub credentials the sandboxed agent never sees — so the
    // engine performs it deterministically from the agent's assessment here, the moment
    // the merger step finishes (NOT only when it is the pipeline's last step, which is
    // why a trailing `post-release-health` step no longer disables auto-merge).
    {
      kind: MERGER_AGENT_KIND,
      applies: (result) => result.mergeAssessment !== undefined,
      resolve: async ({ workspaceId, instance, step, result }) => {
        // The real merge runs the engine GitHub client under the run initiator's
        // ambient context, so a per-user PAT (when set) authors the merge.
        const decision = await d.runInitiatorScope(
          { workspaceId, initiatedBy: instance.initiatedBy },
          () => d.mergeResolver.resolveMergerStep(workspaceId, instance, result.mergeAssessment),
        )
        // Record the structured verdict on the step so the SPA's dedicated merger result
        // view renders the assessment + explains the auto-merge / awaiting-review decision,
        // instead of showing the agent's raw JSON.
        if (decision) {
          step.custom = decision
          // Drop the raw JSON only when we captured a structured assessment (the view
          // renders it from `step.custom`). When the merger produced NO parseable
          // assessment, keep the raw reply so an operator can still diagnose what it sent.
          if (decision.assessment) step.output = ''
        }
        return { ownsTerminalStatus: true }
      },
    },
    // POST-COMPLETION resolvers — run at the early slot (after output is recorded, before
    // the follow-up/approval gates), reshaping the agent's structured result into domain
    // state. Lifted verbatim from the old inline `recordStepResult` branches.
    //
    // A Blueprinter step produced a fresh service decomposition. Validate it with the
    // authoritative schema (a bad payload must never touch the board), then reconcile it
    // in place onto the run's service frame.
    {
      kind: BLUEPRINTS_AGENT_KIND,
      phase: 'post-completion',
      resolve: async ({ workspaceId, instance, result }) => {
        if (result.blueprintService !== undefined) {
          await d.ingestBlueprint(workspaceId, instance.blockId, result.blueprintService)
        }
      },
    },
    // An initiative-analyst step produced a prose codebase analysis. Fold it onto the
    // block's `initiatives` entity (`analysisSummary`) so the planner's prompt is grounded
    // in it. Best-effort: an empty analysis or an unwired store simply leaves the summary
    // unchanged (the planner still runs); never fail the run on a missing analysis.
    {
      kind: INITIATIVE_ANALYST_AGENT_KIND,
      phase: 'post-completion',
      resolve: async ({ workspaceId, instance, result }) => {
        const summary = result.output?.trim()
        if (!d.initiativeService || !summary) return
        await d.initiativeService.recordAnalysis(workspaceId, instance.blockId, summary)
      },
    },
    // An initiative-planner step produced a plan draft. Ingest it into the block's
    // `initiatives` entity (strict-parse at the trust boundary; replay-idempotent —
    // the same draft re-applies to identical content). The run then parks at the
    // planner's human gate; the committer step later mirrors the APPROVED plan into
    // the repo. A malformed draft fails the step loudly — completing the run without
    // an ingested plan would strand the initiative in `planning` with a green run.
    //
    // It also authors the step's reviewable OUTPUT, which is what the human gate parks on.
    // That cannot ride the generic `reviewableArtifactOutput` seam (see the comment there):
    // the plan is the one artifact the ENGINE reshapes on the way to storage — a preset's
    // phase template reorders phases and forces checkpoints, its `seedPlan` hook adds and
    // drops items, and a re-plan carries over items a previous plan already materialised —
    // so only the INGESTED entity is the plan the reviewer's approval actually governs.
    // Rendering the raw draft instead would show a document that quietly differs from what
    // executes. `outputIsRendered` marks it non-editable for the same reason the flag exists
    // everywhere else: the artifact is already committed, so a correction typed over its
    // rendering would reach nothing.
    {
      kind: INITIATIVE_PLANNER_AGENT_KIND,
      phase: 'post-completion',
      resolve: async ({ workspaceId, instance, result }) => {
        if (!d.initiativeService) return
        if (result.initiativePlan === undefined) {
          throw new Error(
            'The initiative planner returned no usable plan (malformed or empty JSON)',
          )
        }
        const ingested = await d.initiativeService.ingestPlan(
          workspaceId,
          instance.blockId,
          result.initiativePlan,
        )
        if (!ingested) {
          throw new Error('No initiative entity found for this block — cannot ingest the plan')
        }
        return { output: renderInitiativePlanForReview(ingested), outputIsRendered: true }
      },
    },
    // A spec-writer step produced the service's unified specification (`spec.json`) and
    // committed it to the implementation branch — strict-validate it then nudge clients —
    // and reports its BUSINESS-vs-TECHNICAL determination. "No business specs" (a purely
    // technical task) is a valid outcome the spec-companion's convergence later combines
    // with its `technicalCorroborated` verdict; recorded even when false so a re-run
    // reflects the latest.
    {
      kind: SPEC_WRITER_AGENT_KIND,
      phase: 'post-completion',
      resolve: async ({ workspaceId, step, result }) => {
        if (result.spec !== undefined) await d.ingestSpec(workspaceId, result.spec)
        step.noBusinessSpecs = result.noBusinessSpecs === true
      },
    },
    // A `task-estimator` step emits a JSON triage (complexity/risk/impact). Parse it
    // tolerantly, persist it on the block (used to gate consensus steps + surfaced in the
    // UI), and replace the raw JSON output with a readable summary. An unparseable estimate
    // leaves the block untouched and keeps the raw output (no run failure). Works the same
    // whether the single-actor estimator or the consensus ranked-scoring variant produced
    // the JSON. Running at the post-completion slot keeps the summary in `step.output`
    // before the approval gate reads it as the proposal.
    // A `bug-investigator` step returns its STRUCTURED triage as `result.custom` (kept on
    // `step.custom` for the generic-structured view + the clarity gate's structured read).
    // Render a prose digest into `step.output` at the post-completion slot so downstream
    // steps (estimator / repro-test / coder) read the investigation via `priorOutputs`
    // (which carries only `step.output`), and the clarity gate's investigation-prose context
    // sees it too. An unparseable result leaves the agent's raw reply on `step.output`.
    {
      kind: BUG_INVESTIGATOR_AGENT_KIND,
      phase: 'post-completion',
      applies: (result) => result.custom !== undefined,
      resolve: async ({ result }) => {
        const digest = renderInvestigationDigest(result.custom)
        if (digest) return { output: digest }
      },
    },
    // A `repro-test` step returns its STRUCTURED outcome as `result.custom` (kept on
    // `step.custom` for the generic-structured view). Render a short prose digest into
    // `step.output` at the post-completion slot so the coder reads the reproduction result
    // (reproduced / conceded + why) via `priorOutputs` (which carries only `step.output`).
    // Conceding never fails the run — the container tolerates a no-op (`noChangesTolerated`),
    // so this only reshapes the output. An unparseable result leaves the raw reply on
    // `step.output`.
    {
      kind: REPRO_TEST_AGENT_KIND,
      phase: 'post-completion',
      applies: (result) => result.custom !== undefined,
      resolve: async ({ result }) => {
        const digest = renderReproDigest(result.custom)
        if (digest) return { output: digest }
      },
    },
    // The two producers of a task's triage scores, from ONE factory: the rule for writing the
    // record is the same for both and only the BASIS differs, so it is stated once (see
    // {@link taskEstimateResolver}).
    taskEstimateResolver(d, TASK_ESTIMATOR_AGENT_KIND, 'predicted'),
    taskEstimateResolver(d, TASK_REASSESSOR_AGENT_KIND, 'observed'),
  ]
  const map = new Map(resolvers.map((r) => [r.kind, r]))
  // Merge deployment-registered resolvers, mirroring the gate registry below. A
  // registered resolver of the same kind replaces the built-in (last registration wins).
  // The registry is the app-owned instance injected through `CoreDependencies`, not a
  // module global.
  const ctx: ResolverContext = { runInitiatorScope: d.runInitiatorScope }
  for (const { kind, factory } of d.stepResolverRegistry.factories()) map.set(kind, factory(ctx))
  return map
}

/**
 * The post-completion resolver for a step that WRITES the task's triage scores, for one `basis`.
 *
 * Two kinds produce that record at opposite ends of a run and the rule for writing it is theirs
 * jointly: coerce the reply tolerantly, and on a readable one revise what the block holds through
 * {@link reviseTaskEstimate}, so the record always carries the last reading of the OTHER basis
 * whichever producer wrote it last. A re-run's fresh forecast on a task that was measured keeps
 * that measurement beside it, and a retried measurement keeps the forecast it corrected. Stated
 * once here rather than twice, because a change to the write rule that lands on one basis only
 * (a metric, an emit, a guard) is a difference nothing else would catch.
 *
 * Deliberately does NOT declare `outputIsRendered`, though the output is a rendering of something
 * just persisted. The flag marks an output an edit cannot REACH, and the test is what CONSUMES the
 * text: a plan or a spec is read back from storage, so a correction typed over their rendering
 * changes nothing, whereas this summary is itself what downstream steps read (`priorOutputs`
 * carries `step.output`). Editing it is therefore partially meaningful — the block's persisted
 * `estimate` stays put, but the text the next step sees does change — so the affordance is left in
 * place rather than refused.
 *
 * An UNREADABLE reply records nothing and keeps the raw output: no run failure, and no invented
 * measurement replacing a real forecast. That matters most for the `observed` producer, whose
 * kind returns prose precisely so a garbled reply cannot fail a run whose change already shipped.
 *
 * The prior record is READ HERE rather than taken from the run context: the context was built at
 * dispatch, and a container job can outlive several minutes of other writes, so what to supersede
 * is whatever the block holds NOW. That read and the write below are not one atomic step, and the
 * bounded consequence is worth stating: two runs settling an estimate on the SAME block at the
 * same time both write a valid current reading and the loser's `supersedes` pair is lost. Never
 * the current scores, which are the last writer's real reading either way, and never a mixture.
 */
function taskEstimateResolver(
  d: DispatcherRegistryDeps,
  kind: string,
  basis: TaskEstimateBasis,
): StepCompletionResolver {
  return {
    kind,
    phase: 'post-completion',
    resolve: async ({ workspaceId, instance, step, result }) => {
      const reading = coerceTaskEstimate(
        step.output ?? '',
        result.model ?? step.model ?? null,
        d.clock.now(),
        basis,
      )
      if (!reading) return
      const block = await d.blockRepository.get(workspaceId, instance.blockId)
      const estimate = reviseTaskEstimate(block?.estimate, reading)
      await d.blockRepository.update(workspaceId, instance.blockId, { estimate })
      return { output: summarizeEstimate(estimate) }
    },
  }
}
