/**
 * The human-gate window controllers the engine composes: the Tester / Ralph / human-test /
 * visual-confirmation gates, the shared review gate, the implementation-fork decision gate and
 * the PR-review gate.
 *
 * Extracted verbatim from the {@link ExecutionService} constructor (which had grown past the
 * per-function line budget — docs/initiatives/lint-complexity-size-ratchet.md) following the
 * established `RunDispatcher` controller pattern: the factory takes ONE deps object of already-
 * built collaborators plus BOUND call-backs for the engine methods the controllers reach back
 * into (`resolveRiskPolicy` / `dispatchIterationCap` / `clockNow`), so every closure still
 * resolves through the live engine instance exactly as before. Behaviour-neutral.
 */

import type {
  BlockRepository,
  Clock,
  ExecutionRepository,
  IdGenerator,
  WorkRunner,
} from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { Block } from '@cat-factory/contracts'
import type { ExecutionServiceDependencies, ResolvedRunRiskPolicy } from './ExecutionService.js'
import type { RunPolicyScope } from './policy-types.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'
import { TesterController } from './TesterController.js'
import { RalphController } from './RalphController.js'
import { HumanTestController } from './HumanTestController.js'
import { VisualConfirmationController } from './VisualConfirmationController.js'
import { ReviewGateController, type ReviewGateControllerDeps } from './ReviewGateController.js'
import { BinaryCandidateController } from './BinaryCandidateController.js'
import { ForkDecisionController } from './ForkDecisionController.js'
import { InputGateController } from './InputGateController.js'
import { PrReviewController } from './PrReviewController.js'
import { InitiativeInterviewController } from './InitiativeInterviewController.js'
import { DocInterviewController } from './DocInterviewController.js'
import { buildBrainstormKind, buildClarityKind, buildRequirementsKind } from './review-kinds.js'
import {
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
} from './ci.logic.js'
import { defaultTaskTypeRegistry } from '@cat-factory/kernel'

/**
 * The already-built collaborators + bound engine call-backs {@link buildGateWindowControllers}
 * needs. Every field is the SAME value the constructor used inline; the three call-backs are
 * bound to the live {@link ExecutionService}, so they resolve against its state at call time.
 */
export interface GateWindowControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  agentExecutor: AgentExecutor
  contextBuilder: AgentContextBuilder
  stateMachine: RunStateMachine
  stepGraph: StepGraph
  idGenerator: IdGenerator
  clock: Clock
  /** The engine clock's `now()`, bound (gate verdicts are stamped with it). */
  clockNow: () => number
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ) => Promise<ResolvedRunRiskPolicy>
  dispatchIterationCap: ReviewGateControllerDeps['dispatchIterationCap']
  notificationService: ExecutionServiceDependencies['notificationService']
  testerQualityReviewer: ExecutionServiceDependencies['testerQualityReviewer']
  environmentProvisioning: ExecutionServiceDependencies['environmentProvisioning']
  environmentTeardown: ExecutionServiceDependencies['environmentTeardown']
  branchUpdater: ExecutionServiceDependencies['branchUpdater']
  resolveBinaryArtifactStore: ExecutionServiceDependencies['resolveBinaryArtifactStore']
  /** The document corpus the visual-confirmation gate reads a task's linked DESIGNS from. */
  documentRepository: ExecutionServiceDependencies['documentRepository']
  forkChatService: ExecutionServiceDependencies['forkChatService']
  /** Tracker writeback — the review gate echoes a HEADLESS park's open findings through it. */
  issueWriteback: ExecutionServiceDependencies['issueWriteback']
  /** Facade logger for that best-effort echo. */
  logger: ExecutionServiceDependencies['logger']
}

/**
 * Build the human-gate window controllers over one shared deps bundle (see the module doc).
 */
export function buildGateWindowControllers(deps: GateWindowControllerDeps) {
  const {
    blockRepository,
    executionRepository,
    workRunner,
    agentExecutor,
    notificationService,
    contextBuilder,
    stateMachine,
    stepGraph,
    idGenerator,
    clock,
    clockNow,
    resolveRiskPolicy,
    dispatchIterationCap,
    testerQualityReviewer,
    environmentProvisioning,
    environmentTeardown,
    branchUpdater,
    resolveBinaryArtifactStore,
    documentRepository,
    forkChatService,
    issueWriteback,
    logger,
  } = deps
  const testerController = new TesterController({
    blockRepository,
    notificationService,
    agentExecutor,
    contextBuilder,
    resolveRiskPolicy,
    stateMachine,
    // The test quality-control companion's inline reviewer (when wired); absent → QC
    // pass-through. Stamps its verdicts with the engine clock.
    ...(testerQualityReviewer ? { qualityReviewer: testerQualityReviewer } : {}),
    clockNow,
  })
  const ralphController = new RalphController({
    blockRepository,
    notificationService,
    agentExecutor,
    contextBuilder,
    stateMachine,
    clockNow,
  })
  const humanTestController = new HumanTestController({
    blockRepository,
    executionRepository,
    workRunner,
    agentExecutor,
    contextBuilder,
    notificationService,
    // The human-test gate READS the env the upstream `deployer` step provisioned (it no longer
    // stands up its own) — resolved by the block's OWN service frame, exactly as the tester
    // context resolves it, so the gate and the tester(s) share the one provisioned env. Left
    // undefined when no provider is wired (the gate degrades to manual mode).
    ...(environmentProvisioning
      ? {
          readEnvironment: async (ws, block) => {
            const frame = await contextBuilder.resolveServiceFrame(ws, block.id)
            const handle = await environmentProvisioning.getHandleForBlock(ws, block.id, frame?.id)
            // Reconcile against the LIVE provider status when the stored record isn't yet
            // `ready`: the deployer records an async provider's env as `provisioning`, and nothing
            // re-polls that row once the deployer step completes, so a slow-but-now-ready env
            // would otherwise read stale and wrongly degrade the gate to manual mode. One refresh
            // reconciles it; an env still genuinely provisioning / failed degrades as before.
            // Best-effort — keep the stored handle if the status read throws.
            if (handle && handle.status !== 'ready') {
              try {
                return await environmentProvisioning.refreshStatus(ws, handle.id)
              } catch {
                return handle
              }
            }
            return handle
          },
        }
      : {}),
    ...(environmentTeardown
      ? {
          teardownEnvironment: async (ws, id) => {
            await environmentTeardown.teardown(ws, id)
          },
        }
      : {}),
    ...(branchUpdater ? { branchUpdater } : {}),
    resolveRiskPolicy,
    stateMachine,
    stepGraph,
    clockNow,
  })
  const visualConfirmationController = new VisualConfirmationController({
    blockRepository,
    executionRepository,
    workRunner,
    agentExecutor,
    contextBuilder,
    notificationService,
    ...(resolveBinaryArtifactStore ? { resolveBinaryArtifactStore } : {}),
    ...(documentRepository ? { documentRepository } : {}),
    resolveRiskPolicy,
    stateMachine,
    stepGraph,
    clockNow,
  })
  const reviewGate = new ReviewGateController({
    blockRepository,
    executionRepository,
    workRunner,
    stateMachine,
    stepGraph,
    resolveRiskPolicy,
    dispatchIterationCap,
    ...(issueWriteback ? { issueWriteback } : {}),
    ...(logger ? { logger } : {}),
  })
  const forkDecisionController = new ForkDecisionController({
    blockRepository,
    executionRepository,
    workRunner,
    stateMachine,
    stepGraph,
    idGenerator,
    clock,
    notificationService,
    ...(forkChatService ? { forkChatService } : {}),
    resolveEffectiveDescription: (ws, block) =>
      contextBuilder.resolveEffectiveDescription(ws, block),
  })
  const prReviewController = new PrReviewController({
    executionRepository,
    workRunner,
    stateMachine,
    stepGraph,
    idGenerator,
    clock,
    notificationService,
  })
  const binaryCandidateController = new BinaryCandidateController({
    blockRepository,
    executionRepository,
    workRunner,
    stateMachine,
    stepGraph,
    idGenerator,
    clock,
    notificationService,
  })
  return {
    testerController,
    ralphController,
    humanTestController,
    visualConfirmationController,
    reviewGate,
    forkDecisionController,
    prReviewController,
    binaryCandidateController,
  }
}

/**
 * The already-built collaborators {@link buildReviewSubjects} needs. Same values the
 * constructor used inline.
 */
export interface ReviewSubjectDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  stateMachine: RunStateMachine
  stepGraph: StepGraph
  executionEventPublisher: ExecutionServiceDependencies['executionEventPublisher']
  requirementReviewService: ExecutionServiceDependencies['requirementReviewService']
  clarityReviewService: ExecutionServiceDependencies['clarityReviewService']
  brainstormServices: ExecutionServiceDependencies['brainstormServices']
  initiativeService: ExecutionServiceDependencies['initiativeService']
  initiativeInterviewService: ExecutionServiceDependencies['initiativeInterviewService']
  docInterviewService: ExecutionServiceDependencies['docInterviewService']
}

/**
 * Build the review-gate SUBJECTS (requirements / clarity / the two brainstorm stages) plus the
 * two interactive interview gates (initiative planning, document interview). Extracted verbatim
 * from the {@link ExecutionService} constructor for the per-function line budget — each
 * subject's differentiators still live in `review-kinds.ts`, not on the engine.
 */
export function buildReviewSubjects(deps: ReviewSubjectDeps) {
  const {
    blockRepository,
    executionRepository,
    workRunner,
    stateMachine,
    stepGraph,
    executionEventPublisher,
    requirementReviewService,
    clarityReviewService,
    brainstormServices,
    initiativeService,
    initiativeInterviewService,
    docInterviewService,
  } = deps
  // The review-gate subjects (requirements / clarity / the two brainstorm stages), built by
  // the factories in review-kinds.ts over one shared closure of collaborators — each subject's
  // differentiators live there, not on the engine.
  const reviewKindDeps = {
    events: executionEventPublisher,
    blockRepository,
    executionRepository,
    requirementReviewService,
    clarityReviewService,
    brainstormServices,
  }
  const requirementsKind = buildRequirementsKind(reviewKindDeps)
  const clarityKind = buildClarityKind(reviewKindDeps)
  const requirementsBrainstormKind = buildBrainstormKind(
    'requirements',
    REQUIREMENTS_BRAINSTORM_AGENT_KIND,
    reviewKindDeps,
  )
  const architectureBrainstormKind = buildBrainstormKind(
    'architecture',
    ARCHITECTURE_BRAINSTORM_AGENT_KIND,
    reviewKindDeps,
  )
  // The interactive-planning interviewer gate — wired whenever the initiative store is
  // present (the entity is where its state lives). The interviewer LLM is optional: without
  // it (or without a model) the gate passes through, so planning still runs off the raw
  // block description. Absent initiative store → the `initiative-interviewer` step passes
  // through in RunDispatcher (an initiative pipeline can't run without the store anyway).
  const initiativeInterviewController = initiativeService
    ? new InitiativeInterviewController({
        blockRepository,
        executionRepository,
        workRunner,
        stateMachine,
        stepGraph,
        interviewService: initiativeInterviewService,
        initiativeService,
      })
    : undefined
  // The interactive document-interview gate (WS5) — wired whenever the interview service is
  // present. Without it (or without a model) the gate passes through, so document pipelines
  // still run off the raw outline. Self-contained persistence lives in the service.
  const docInterviewController = docInterviewService
    ? new DocInterviewController({
        blockRepository,
        executionRepository,
        workRunner,
        stateMachine,
        stepGraph,
        events: executionEventPublisher,
        docInterviewService,
      })
    : undefined
  return {
    requirementsKind,
    clarityKind,
    requirementsBrainstormKind,
    architectureBrainstormKind,
    initiativeInterviewController,
    docInterviewController,
  }
}

/**
 * The PRE-DISPATCH INPUT GATE, built from the SAME whole dependency object the sibling factories
 * above are handed, plus the two collaborators `ExecutionService` builds for itself.
 *
 * It is deliberately not one of the gate windows: it guards the run's FIRST dispatch and has no
 * pipeline step of its own, which is why it is a separate factory rather than another field on
 * `buildGateWindowControllers`' result. It lives in this module for the reason
 * `buildReviewSubjects` does: this is where an engine collaborator is assembled out of the
 * dependency bag. Taking the bag rather than eight named fields is the point — a hand-forwarded
 * list is how `agentPromptRepository` was once silently dropped (see the constructor's note), and
 * doing it inline was what pushed that constructor over its size budget.
 */
export function buildInputGateController(
  dependencies: ExecutionServiceDependencies,
  runtime: { stateMachine: RunStateMachine; stepGraph: StepGraph },
): InputGateController {
  return new InputGateController({
    blockRepository: dependencies.blockRepository,
    executionRepository: dependencies.executionRepository,
    workRunner: dependencies.workRunner,
    stateMachine: runtime.stateMachine,
    stepGraph: runtime.stepGraph,
    clock: dependencies.clock,
    // An EMPTY registry, not `undefined`: a facade that registers no custom task types has
    // nothing declaring required fields, which is a real answer rather than a missing one.
    taskTypeRegistry: dependencies.taskTypeRegistry ?? defaultTaskTypeRegistry(),
    workspaceSettingsService: dependencies.workspaceSettingsService,
    logger: dependencies.logger,
  })
}
