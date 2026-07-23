import type {
  AgentJobUpdate,
  BlockRepository,
  Clock,
  ContainerEvictionKind,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { failureKindFromHarnessCause } from '@cat-factory/kernel'
import { PR_REVIEWER_KIND } from '@cat-factory/agents'
import { HUMAN_TEST_AGENT_KIND, isTesterKind, VISUAL_CONFIRM_AGENT_KIND } from './ci.logic.js'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { TesterController } from './TesterController.js'
import type { HumanTestController } from './HumanTestController.js'
import type { VisualConfirmationController } from './VisualConfirmationController.js'
import type { PrReviewController } from './PrReviewController.js'

/** A settled (non-`running`) agent poll — the only states {@link PollCompletionController} acts on. */
type SettledUpdate = Extract<AgentJobUpdate, { state: 'done' } | { state: 'failed' }>

/**
 * Collaborators + bound call-backs the {@link PollCompletionController} needs. The three
 * `recordBackendDiagnostics` / `recoverContainerEviction` / `markContainerErrored` hooks are bound
 * methods of the dispatcher so completion still runs against the SAME dispatcher state the inline
 * code did.
 */
export interface PollCompletionControllerDeps {
  blockRepository: BlockRepository
  clock: Clock
  runStateMachine: RunStateMachine
  testerController: TesterController
  humanTestController: HumanTestController
  visualConfirmationController: VisualConfirmationController
  prReviewController: PrReviewController
  recordBackendDiagnostics: (instance: ExecutionInstance, backend: string | undefined) => void
  recoverContainerEviction: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    error: string | undefined,
    evicted: ContainerEvictionKind | undefined,
  ) => Promise<AdvanceResult | null>
  markContainerErrored: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ) => Promise<void>
}

/**
 * Resolves a settled agent poll for a parked step: the helper-in-flight phase branches (a tester /
 * human-test / visual-confirmation gate's Fixer/conflict-resolver round) and the terminal
 * `failed`-poll handling. Extracted from {@link RunDispatcher} as a cohesive collaborator (the
 * settled-poll branch tree) so the dispatcher's `pollAgentJobInner` stays under the complexity
 * ceiling; the dispatcher delegates its poll-completion call sites here.
 */
export class PollCompletionController {
  private readonly blockRepository: BlockRepository
  private readonly clock: Clock
  private readonly runStateMachine: RunStateMachine
  private readonly testerController: TesterController
  private readonly humanTestController: HumanTestController
  private readonly visualConfirmationController: VisualConfirmationController
  private readonly prReviewController: PrReviewController
  private readonly recordBackendDiagnostics: PollCompletionControllerDeps['recordBackendDiagnostics']
  private readonly recoverContainerEviction: PollCompletionControllerDeps['recoverContainerEviction']
  private readonly markContainerErrored: PollCompletionControllerDeps['markContainerErrored']

  constructor(deps: PollCompletionControllerDeps) {
    this.blockRepository = deps.blockRepository
    this.clock = deps.clock
    this.runStateMachine = deps.runStateMachine
    this.testerController = deps.testerController
    this.humanTestController = deps.humanTestController
    this.visualConfirmationController = deps.visualConfirmationController
    this.prReviewController = deps.prReviewController
    this.recordBackendDiagnostics = deps.recordBackendDiagnostics
    this.recoverContainerEviction = deps.recoverContainerEviction
    this.markContainerErrored = deps.markContainerErrored
  }

  /**
   * Settle a helper job (Fixer / conflict-resolver) that a tester / human-test /
   * visual-confirmation gate has in flight — NOT the step's own work. Records the round's outcome
   * and re-parks/re-dispatches instead of recording a step result. Returns null when this step has
   * no such helper in flight, so the caller falls through to the ordinary completion path.
   */
  async resolveHelperPhaseCompletion(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: SettledUpdate,
  ): Promise<AdvanceResult | null> {
    // A `tester` step in its `fixing` phase has a Fixer job in flight, NOT the
    // step's own work: when it finishes (or fails) we drop the handle, return to
    // `testing`, and re-dispatch the Tester against the (now-fixed) branch — its
    // fresh report then drives greenlight-or-loop again. Mirrors the CI gate.
    if (isTesterKind(step.agentKind) && step.test?.phase === 'fixing') {
      // Record this fixer round (what it was handed + how it ended) so the test window can
      // show an inspectable timeline of the otherwise-opaque fixer sub-jobs. Persisted as
      // part of the re-dispatch below.
      this.testerController.recordFixerOutcome(
        step,
        update.state === 'done'
          ? { state: 'done', output: update.result.output ?? null }
          : { state: 'failed', error: update.error ?? null },
        this.clock.now(),
      )
      step.jobId = undefined
      step.subtasks = undefined
      step.test.phase = 'testing'
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      if (!block) return { kind: 'noop' }
      // Reclaim the finished Fixer container before re-dispatching the Tester so it
      // boots fresh against the just-pushed fixes (rather than re-attaching to the
      // completed job by run id).
      await this.runStateMachine.stopRunContainer(workspaceId, instance)
      return this.testerController.dispatchTester(workspaceId, instance, step, block)
    }

    // A `human-test` gate in its `fixing` / `resolving_conflicts` phase has a helper job
    // (fixer / conflict-resolver) in flight, NOT the step's own work: when it settles —
    // done OR failed — record the round's outcome, rebuild the environment against the
    // (now-updated) branch and re-park the human. We never fail the run here; the human is
    // in control. Mirrors the Tester→Fixer loop.
    if (
      step.agentKind === HUMAN_TEST_AGENT_KIND &&
      (step.humanTest?.phase === 'fixing' || step.humanTest?.phase === 'resolving_conflicts')
    ) {
      return this.humanTestController.onHelperComplete(workspaceId, instance, step, {
        state: update.state === 'failed' ? 'failed' : 'done',
      })
    }

    // A `visual-confirmation` gate in its `fixing` phase has a `fixer` job in flight: when it
    // settles, record the round, refresh the screenshot pairs, and re-park the human.
    if (step.agentKind === VISUAL_CONFIRM_AGENT_KIND && step.visualConfirm?.phase === 'fixing') {
      return this.visualConfirmationController.onHelperComplete(workspaceId, instance, step, {
        state: update.state === 'failed' ? 'failed' : 'done',
      })
    }

    return null
  }

  /**
   * Resolve a `failed` agent poll: record backend diagnostics, attempt transient container-eviction
   * recovery, settle a read-only Challenge Investigator failure by re-parking the review, else mark
   * the container errored and report `job_failed` with the harness's classified cause.
   */
  async handleFailedPoll(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: Extract<AgentJobUpdate, { state: 'failed' }>,
  ): Promise<AdvanceResult> {
    // Preserve the transport-reported backend (native host process vs. sandboxed container)
    // BEFORE branching on eviction: a first-poll failure/eviction may never have hit the
    // running branch that normally records it, and an evicted run is exactly the case a
    // post-mortem inspects ("which backend evicted this?"). Idempotent, so it's harmless when
    // the running branch already stamped it; whichever path upserts below persists it — the
    // eviction re-dispatch/exhausted upsert in recoverContainerEviction, or markContainerErrored
    // on a genuine failure (failRun then re-reads from storage).
    this.recordBackendDiagnostics(instance, update.backend)
    // A container eviction (the per-run container vanished, its in-memory job is gone) is
    // usually transient. The shared recovery drops the dead handle and returns `continue` so
    // the driver re-dispatches the SAME step to a fresh container, within the per-flavour
    // budget (transient infra churn vs a crash/OOM); once the budget is spent it fails the run
    // as `evicted`. Returns null for a genuine agent/job failure, handled below.
    const recovered = await this.recoverContainerEviction(
      workspaceId,
      instance,
      step,
      update.error,
      update.evicted,
    )
    if (recovered) return recovered
    // A read-only Challenge Investigator (dispatched off a parked `pr-reviewer` step when the
    // human challenged ONE finding) failed for real: settle the challenge as `failed` and RE-PARK
    // the review — a non-critical second opinion crashing must not fail the human's in-flight
    // curation. Mirrors the human-test / visual-confirmation helper-failure branches above.
    if (step.agentKind === PR_REVIEWER_KIND && step.prReview?.status === 'challenging') {
      const settled = await this.prReviewController.recordChallengeFailure(
        workspaceId,
        instance,
        step,
        update.error,
      )
      if (settled) return settled
    }
    // Not an eviction: a genuine agent/job failure. Prefer the harness's STRUCTURED cause
    // to classify it (→ AgentFailureKind), falling back to the error-string regex when an
    // older image (or a pool transport that doesn't forward the cause) reported none — the
    // same regex the bootstrap path uses, so a watchdog timeout still classifies as `timeout`
    // rather than a generic `agent`. The extended diagnostic surfaces as the failure detail.
    // Mark the container errored and persist so the failed details show it (failRun
    // re-reads from storage, so an in-memory-only mutation would be lost; failRun emits
    // the terminal frame, so markContainerErrored deliberately doesn't).
    await this.markContainerErrored(workspaceId, instance, step)
    return {
      kind: 'job_failed',
      error: update.error,
      // Prefer the harness's structured cause; default to the coarse `agent` when it reported
      // none (the watchdog-phrase string fallback is gone — current images always emit a cause).
      failureKind: failureKindFromHarnessCause(update.failureCause) ?? 'agent',
      detail: update.detail ?? update.error,
      // Preserve the harness's FINE-GRAINED cause (git / api / no-usable-output / no-changes)
      // that `failureKind` collapses to the coarse `agent` — recorded on the failure's
      // machine-readable `reason` so a post-mortem sees it was e.g. a `git` push failure, not
      // a generic agent error, without regrepping the transcript.
      ...(update.failureCause ? { reason: update.failureCause } : {}),
    }
  }
}
