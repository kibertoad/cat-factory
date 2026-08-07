import type { ExecutionInstance } from '@cat-factory/kernel'
import type { PrVerificationReport, RunOutcome, ServiceSpecView } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The three READ paths onto a run's evidence, resolved by run id for a caller holding nothing but
// one: the verification report (`GET /api/v1/runs/:runId/report`), the outcome summary
// (`GET /api/v1/runs/:runId/outcome`), and the `spec/` those two join against, which the SPA's
// outcome card fetches because it composes the same reduction locally.
//
// One collaborator rather than three methods on `ExecutionService`, and not only for that file's
// size budget: every one of them is the same two steps (resolve the run, hand it to the evidence
// controller), and the ONE thing they must never disagree about is what "this run" resolves to.
// Three copies of the resolve is how a fourth read would eventually acquire its own.
// ---------------------------------------------------------------------------

/**
 * Bound callbacks rather than the collaborators themselves, so this stays testable standalone and
 * cannot reach for anything its three reads do not need.
 */
export interface RunEvidenceReadsDeps {
  /** Resolve a run within a workspace. Null when the workspace has no such run. */
  getInstance(workspaceId: string, executionId: string): Promise<ExecutionInstance | null>
  composeReport(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<PrVerificationReport | null>
  composeOutcome(workspaceId: string, instance: ExecutionInstance): Promise<RunOutcome | null>
  readSpec(workspaceId: string, instance: ExecutionInstance): Promise<ServiceSpecView>
}

export class RunEvidenceReads {
  constructor(private readonly deps: RunEvidenceReadsDeps) {}

  /**
   * The run's verification report, composed for a READER rather than published onto a pull
   * request. Null when the workspace has no such run, or when the run's block is gone.
   *
   * The SAME composition the PR body carries (see
   * `PrVerificationReportController.composeForRun` for the three differences the read path makes,
   * all of them about audience rather than content).
   */
  async report(workspaceId: string, executionId: string): Promise<PrVerificationReport | null> {
    const instance = await this.deps.getInstance(workspaceId, executionId)
    if (!instance) return null
    return this.deps.composeReport(workspaceId, instance)
  }

  /**
   * The run's OUTCOME summary. Null on the same two conditions as {@link report}.
   *
   * Its sibling, and deliberately routed through the same collaborator: the two documents answer
   * one question for different readers (a reviewer who will open the diff, and someone who never
   * will), so they read one run's evidence once, through one loader, and share the coverage rules
   * underneath. The SPA composes this same reduction live off its own store, which is why it is a
   * pure function in `@cat-factory/contracts` rather than a projection invented on this side of
   * the wire.
   */
  async outcome(workspaceId: string, executionId: string): Promise<RunOutcome | null> {
    const instance = await this.deps.getInstance(workspaceId, executionId)
    if (!instance) return null
    return this.deps.composeOutcome(workspaceId, instance)
  }

  /**
   * The run's `spec/`, read from the branch the run pushed its work to: what the SPA's outcome
   * card joins this run's requirement verdicts against.
   *
   * The card composes {@link outcome}'s reduction locally so it can react to pushed step updates,
   * which leaves the spec as the one input it has to fetch. Fetching the SERVICE's spec (the repo
   * DEFAULT branch, what the inspector's requirements window wants) is a different document while
   * a pull request is open, and every verdict naming a requirement the increment added landed as
   * "not checked". Routed through the loader the two documents above use, so all three read one
   * branch by one rule.
   *
   * Null when the workspace has no such run. An unreadable spec is `{ present: false }`, which the
   * card already states as `spec: 'not_read'` rather than as a clean, empty section.
   */
  async spec(workspaceId: string, executionId: string): Promise<ServiceSpecView | null> {
    const instance = await this.deps.getInstance(workspaceId, executionId)
    if (!instance) return null
    return this.deps.readSpec(workspaceId, instance)
  }
}
