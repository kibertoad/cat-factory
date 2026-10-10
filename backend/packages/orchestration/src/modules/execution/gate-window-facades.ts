import type {
  BrainstormSession,
  BrainstormStage,
  ClarityReview,
  ExecutionInstance,
  RequirementReview,
  RequestRecommendationItem,
  ResolveRequirementsExceededChoice,
} from '@cat-factory/kernel'
import type { ReviewCommon } from '../review/IterativeReviewService.js'
import type { ReviewGateController, ReviewKind } from './ReviewGateController.js'

// ---------------------------------------------------------------------------
// Gate-window action sub-facades
// ---------------------------------------------------------------------------
//
// The dedicated review/test windows drive a parked gate from the SPA through a cluster of
// thin actions (run a pass, incorporate, re-review, proceed, resolve-at-cap, …). Those used
// to be ~30 near-identical 3-line delegations on `ExecutionService`, bloating its public
// surface. They are grouped here into per-feature sub-facades, exposed as getters on the
// still-injected `ExecutionService` (`.requirementsReview` / `.clarityReview` / `.brainstorm`
// / `.humanTest` / `.visualConfirm`) and consumed by the matching server controllers. The
// composition roots are untouched — the single `executionService` is still what every facade
// injects — so the runtimes stay symmetric.

/**
 * The iterative-review window actions over ONE pre-bound {@link ReviewKind}: run a fresh pass,
 * fold the human's answers, re-review the incorporated doc, proceed, or resolve a review that
 * hit its iteration cap. Each is a verbatim delegation to the shared {@link ReviewGateController}
 * with the kind pre-applied, so the requirements / clarity windows honour the task's preset
 * identically. Shared by the pipeline gate and the off-path inspector "Run review" surface.
 */
class ReviewWindowActions<TReview extends ReviewCommon> {
  constructor(
    protected readonly reviewGate: ReviewGateController,
    protected readonly kind: ReviewKind<TReview>,
  ) {}

  /** Run a fresh reviewer pass over a block, snapshotting the task's merge-preset knobs. */
  review(workspaceId: string, blockId: string): Promise<TReview> {
    return this.reviewGate.review(this.kind, workspaceId, blockId)
  }

  /**
   * Incorporate the human's settled answers ASYNCHRONOUSLY. Validates that every finding is
   * answered/dismissed, flags the review `incorporating`, records the intent on the parked
   * gate step, and signals the durable driver to wake — which folds the answers and
   * re-reviews in the background. Off-path (no parked run) the fold + re-review run inline.
   */
  incorporate(workspaceId: string, blockId: string, feedback?: string): Promise<TReview> {
    return this.reviewGate.incorporate(this.kind, workspaceId, blockId, feedback)
  }

  /**
   * Re-review the incorporated document (one more reviewer pass). On convergence the parked
   * run advances; otherwise the window shows the next cycle (`ready`) or the cap (`exceeded`).
   */
  reReview(workspaceId: string, blockId: string): Promise<TReview> {
    return this.reviewGate.reReview(this.kind, workspaceId, blockId)
  }

  /** Proceed: settle the review (the last incorporated doc wins downstream) and advance. */
  proceed(workspaceId: string, blockId: string): Promise<TReview> {
    return this.reviewGate.proceed(this.kind, workspaceId, blockId)
  }

  /** Resolve a review that hit its iteration cap (extra-round / proceed / stop-reset). */
  resolveExceeded(
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<TReview> {
    return this.reviewGate.resolveExceeded(this.kind, workspaceId, blockId, choice)
  }
}

/**
 * The requirements-review window: the common iterative-review actions plus the two
 * Requirement-Writer recommendation actions (batch-generate answers for a set of findings,
 * and re-request a single one with a "do it differently" note).
 */
export class RequirementReviewActions extends ReviewWindowActions<RequirementReview> {
  /**
   * Ask the Requirement Writer to recommend answers for a batch of findings ASYNCHRONOUSLY:
   * append `pending` placeholders at once and signal the driver to run the Writer per finding
   * in the background. Returns the review with the placeholders so the SPA shows "generating…".
   */
  requestRecommendations(
    workspaceId: string,
    blockId: string,
    items: RequestRecommendationItem[],
  ): Promise<RequirementReview> {
    return this.reviewGate.requestRecommendations(this.kind, workspaceId, blockId, items)
  }

  /**
   * Re-request a single recommendation with a "do it differently" note — resets it to `pending`
   * and drives the Writer through the same async path. Review-scoped (addressed by review id).
   */
  reRequestRecommendation(
    workspaceId: string,
    reviewId: string,
    recId: string,
    note: string,
  ): Promise<RequirementReview> {
    return this.reviewGate.reRequestRecommendation(this.kind, workspaceId, reviewId, recId, note)
  }
}

/** The clarity-review (bug-report triage) window actions over the pre-bound clarity kind. */
export class ClarityReviewActions extends ReviewWindowActions<ClarityReview> {}

/**
 * The brainstorm (structured-dialogue) window actions. Unlike requirements/clarity, the
 * brainstorm kind is stage-keyed (requirements vs architecture), so every action takes the
 * `stage` and resolves the kind through the injected `kindFor`.
 */
export class BrainstormActions {
  constructor(
    private readonly reviewGate: ReviewGateController,
    private readonly kindFor: (stage: BrainstormStage) => ReviewKind<BrainstormSession>,
  ) {}

  /** Run a fresh brainstorm pass over a block + stage (off-path inspector / window surface). */
  review(workspaceId: string, blockId: string, stage: BrainstormStage): Promise<BrainstormSession> {
    return this.reviewGate.review(this.kindFor(stage), workspaceId, blockId)
  }

  /** Incorporate the human's picks ASYNCHRONOUSLY (the brainstorm mirror of incorporate). */
  incorporate(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
    feedback?: string,
  ): Promise<BrainstormSession> {
    return this.reviewGate.incorporate(this.kindFor(stage), workspaceId, blockId, feedback)
  }

  /** Re-run the brainstorm against the converged direction (one more pass). */
  reReview(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
  ): Promise<BrainstormSession> {
    return this.reviewGate.reReview(this.kindFor(stage), workspaceId, blockId)
  }

  /** Proceed: settle the brainstorm (last converged direction wins downstream) and advance. */
  proceed(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
  ): Promise<BrainstormSession> {
    return this.reviewGate.proceed(this.kindFor(stage), workspaceId, blockId)
  }

  /** Resolve a brainstorm that hit its iteration cap (extra-round / proceed / stop-reset). */
  resolveExceeded(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<BrainstormSession> {
    return this.reviewGate.resolveExceeded(this.kindFor(stage), workspaceId, blockId, choice)
  }
}

/**
 * The human-testing gate window actions (driven from the dedicated window): confirm the change
 * works, submit findings + request a fix, pull main, or rebuild / destroy the ephemeral env.
 * This is the action subset of the orchestration `HumanTestController` — declared as an
 * interface so the engine can expose the controller as a getter WITHOUT leaking its
 * engine-internal `evaluate` step-handler entrypoint to the server controllers.
 */
export interface HumanTestActions {
  /** Confirm the change works: tear the ephemeral env down and advance the run. */
  confirm(workspaceId: string, blockId: string): Promise<ExecutionInstance>
  /** Submit findings and request a fix: dispatch the Tester's `fixer`, then rebuild the env. */
  requestFix(workspaceId: string, blockId: string, findings: string): Promise<ExecutionInstance>
  /** Pull the repo default branch into the PR branch + redeploy (conflict → conflict-resolver). */
  pullMain(workspaceId: string, blockId: string): Promise<ExecutionInstance>
  /** Rebuild the ephemeral environment on demand. */
  recreateEnvironment(workspaceId: string, blockId: string): Promise<ExecutionInstance>
  /** Destroy the ephemeral environment on demand (the run stays parked). */
  destroyEnvironment(workspaceId: string, blockId: string): Promise<ExecutionInstance>
}

/**
 * The visual-confirmation gate window actions (driven from the dedicated window): approve the
 * reviewed screenshots, submit findings + request a fix, or recapture the screenshot pairs.
 * The action subset of the orchestration `VisualConfirmationController` (see {@link HumanTestActions}).
 */
export interface VisualConfirmActions {
  /** Approve the reviewed screenshots: advance the run. */
  approve(workspaceId: string, blockId: string): Promise<ExecutionInstance>
  /** Submit findings and request a fix: dispatch the Tester's `fixer`, then re-park. */
  requestFix(workspaceId: string, blockId: string, findings: string): Promise<ExecutionInstance>
  /** Refresh the screenshot pairs from the latest UI-tester report. */
  recapture(workspaceId: string, blockId: string): Promise<ExecutionInstance>
}
