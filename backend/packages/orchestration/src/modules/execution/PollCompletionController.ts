import type {
  AgentJobUpdate,
  BlockRepository,
  Clock,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { failureKindFromHarnessCause } from '@cat-factory/kernel'
import {
  type ContainerFailureView,
  containerShutdownFailure,
  MAX_BRANCH_CONTENTION_RECOVERIES,
} from './job.logic.js'
import { PR_REVIEWER_KIND } from '@cat-factory/agents'
import { HUMAN_TEST_AGENT_KIND, isTesterKind, VISUAL_CONFIRM_AGENT_KIND } from './ci.logic.js'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { TesterController } from './TesterController.js'
import type { HumanTestController } from './HumanTestController.js'
import type { VisualConfirmationController } from './VisualConfirmationController.js'
import type { PrReviewController } from './PrReviewController.js'
import {
  applyValidationReport,
  coerceValidationReport,
  validationFailureDetail,
} from './validation.logic.js'
import { applyReproductionReport } from './reproductionProof.logic.js'

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
    failure: ContainerFailureView,
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
    // Fold the job's EVIDENCE next, ahead of every recovery below, because a recovered failure
    // returns without reaching the reporting path and the evidence outlives the job either way. The
    // harness writes both reports onto the job view as its phases finish, independent of what later
    // killed the job: a refused work-branch push settles a job carrying a completed (typically
    // green) validation report and a finished reproduction proof, and dropping them here would
    // discard exactly the runs whose evidence a reader needs. Idempotent, so the re-dispatch's own
    // report simply replaces this one; persisted by whichever path upserts below.
    const validationDetail = this.applyValidationFailure(step, update.validationReport)
    applyReproductionReport(step, update.reproductionReport)
    // A container eviction (the per-run container vanished, its in-memory job is gone) is
    // usually transient. The shared recovery drops the dead handle and returns `continue` so
    // the driver re-dispatches the SAME step to a fresh container, within the per-flavour
    // budget (transient infra churn vs a crash/OOM); once the budget is spent it fails the run
    // as `evicted`. Returns null for a genuine agent/job failure, handled below.
    // `update.detail` is the transport's container post-mortem (exit state + log tail). It only
    // surfaces if the eviction budget is spent; a recovered eviction re-dispatches and needs no
    // diagnostic.
    const recovered = await this.recoverContainerEviction(workspaceId, instance, step, update)
    if (recovered) return recovered
    // A push to the work branch that was REFUSED because the branch moved under the run is the
    // other failure the engine can resolve by itself: re-dispatching resumes the branch as it now
    // stands, which is precisely what the rejection asks for. Checked right after eviction and
    // before every kind-specific branch below, because both are "this job never got to say
    // anything about the work" rather than a verdict on it.
    const resumedAfterContention = await this.recoverBranchContention(
      workspaceId,
      instance,
      step,
      update,
    )
    if (resumedAfterContention) return resumedAfterContention
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
    // A harness that exited cleanly mid-job was stopped by something a fresh container meets
    // again, so this fails the run outright rather than spending an eviction budget on it. It is
    // asked HERE, below every branch that settles a job WITHOUT failing the run, because those
    // branches are about whose job died rather than about how: a killed Challenge Investigator is
    // still a non-critical second opinion, and failing the human's in-flight curation over it
    // would trade one wrong recovery for a worse one. It cannot be reached by the eviction
    // recovery above either way (`harnessShutdown` is never set beside `evicted`), so nothing
    // above it spends a retry on this failure.
    const shutdown = containerShutdownFailure(update)
    if (shutdown) {
      await this.markContainerErrored(workspaceId, instance, step)
      return { kind: 'job_failed', ...shutdown }
    }
    // Not an eviction: a genuine agent/job failure. Prefer the harness's STRUCTURED cause
    // to classify it (→ AgentFailureKind), falling back to the error-string regex when an
    // older image (or a pool transport that doesn't forward the cause) reported none — the
    // same regex the bootstrap path uses, so a watchdog timeout still classifies as `timeout`
    // rather than a generic `agent`. The extended diagnostic surfaces as the failure detail.
    // Mark the container errored and persist so the failed details show it (failRun
    // re-reads from storage, so an in-memory-only mutation would be lost; failRun emits
    // the terminal frame, so markContainerErrored deliberately doesn't). The two harness reports
    // were already folded onto the step above: a red PRE-PR VALIDATION lends its rendered detail
    // to this failure (so the board's card shows WHICH check failed and what it printed), and the
    // reproduction proof never contributes one, the detail belonging to whatever killed the job.
    await this.markContainerErrored(workspaceId, instance, step)
    return {
      kind: 'job_failed',
      error: update.error,
      // Prefer the harness's structured cause; default to the coarse `agent` when it reported
      // none (the watchdog-phrase string fallback is gone — current images always emit a cause).
      failureKind: failureKindFromHarnessCause(update.failureCause) ?? 'agent',
      detail: validationDetail ?? update.detail ?? update.error,
      // Preserve the harness's FINE-GRAINED cause (git / api / no-usable-output / no-changes)
      // that `failureKind` collapses to the coarse `agent` — recorded on the failure's
      // machine-readable `reason` so a post-mortem sees it was e.g. a `git` push failure, not
      // a generic agent error, without regrepping the transcript.
      ...(update.failureCause ? { reason: update.failureCause } : {}),
    }
  }

  /**
   * Recover a step whose push to the work branch was refused because the branch had moved under it
   * (the harness's `branch-contended` cause: a second writer, or a rewrite of history an earlier
   * run published). Resets the step so the driver re-dispatches it, and the fresh dispatch RESUMES
   * the existing branch, so the agent continues on top of whatever is now on it instead of against
   * it, then returns `continue`. Returns null once the bounded budget is spent, so the caller reports the
   * harness's rejection, remedy included, as the run's failure.
   *
   * Lives here rather than beside `recoverContainerEviction` (which the deployer path shares)
   * because only an agent step pushes a work branch: a deployer job has no branch to contend for.
   *
   * The step's own work is NOT lost by failing here either way, since the refused push means the
   * branch already holds commits, so this recovery buys a race its resolution, and never data.
   */
  private async recoverBranchContention(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: Extract<AgentJobUpdate, { state: 'failed' }>,
  ): Promise<AdvanceResult | null> {
    if (update.failureCause !== 'branch-contended') return null
    const recoveries = step.branchContentionRecoveries ?? 0
    if (recoveries >= MAX_BRANCH_CONTENTION_RECOVERIES) return null
    step.branchContentionRecoveries = recoveries + 1
    step.jobId = undefined
    step.subtasks = undefined
    step.progress = 0
    // The job's container is finished with; a fresh one boots for the re-dispatch, so the details
    // show it spinning up again rather than a stale "up" (the eviction recovery's reasoning).
    step.container = { status: 'starting' }
    await this.runStateMachine.persistAndEmit(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Fold a failed poll's pre-PR validation report onto the step and render its failure detail.
   * Returns the detail string when the report describes a red checkout (so the caller can prefer
   * it over the harness's generic diagnostic), else `null` — for a job that carried no report, or
   * one whose checks had actually passed before some unrelated failure.
   */
  private applyValidationFailure(step: PipelineStep, raw: unknown): string | null {
    const report = coerceValidationReport(raw)
    if (!report) return null
    applyValidationReport(step, report)
    return validationFailureDetail(report)
  }
}
