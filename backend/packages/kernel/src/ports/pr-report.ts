// Port for publishing the engine's verification report onto a block's pull request.
//
// The execution engine composes the report from the run's own already-loaded state (see
// `@cat-factory/orchestration`'s `prReport.logic.ts`) and hands the RENDERED markdown
// section here; resolving which PR that is — and how to read/write its description — is the
// adapter's job, exactly as with {@link PullRequestMerger} and {@link CiStatusProvider}. So
// core stays free of VCS specifics and a GitLab deployment gets the report through the same
// call (`@cat-factory/server`'s `GitHubPrReportPublisher` runs on whatever `GitHubClient` the
// facade wired as its engine VCS client, which is the GitLab-backed adapter on a GitLab-only
// deployment).
//
// Idempotency is the adapter's contract, not the caller's: the section is spliced into a
// marker-delimited region of the PR body (`domain/pr-report.ts`), so a retry, a re-run, or a
// replayed durable step updates in place instead of appending a second report.

/** Why a publish did nothing, when it didn't publish. */
export type PrReportSkipReason =
  /** The block has no recorded pull request yet (nothing to write onto). */
  | 'no_pull_request'
  /** The block's repo could not be resolved (no linked repo projection row). */
  | 'no_repo'
  /** The PR body already carried exactly this section — no remote write was made. */
  | 'unchanged'

/** The outcome of one publish attempt. */
export interface PrReportPublishResult {
  /** True when the remote PR description was actually updated. */
  published: boolean
  /** Set when `published` is false; see {@link PrReportSkipReason}. */
  skipped?: PrReportSkipReason
  /** The pull request the report was written onto, when one was resolved. */
  prNumber?: number
}

export interface PrVerificationReportPublisher {
  /**
   * Upsert the engine-managed verification-report section on the block's pull request.
   * `section` is the fully rendered markdown (human-readable prose + the fenced JSON block);
   * the adapter reads the PR's current body, splices the marked region, and writes it back
   * ONLY when it changed.
   *
   * Never throws for an absent PR / repo — those are ordinary skips (a run may open its PR on
   * a later step, or produce none at all). A transport failure MAY throw; the engine treats a
   * failed publish as best-effort bookkeeping and never fails a run over it.
   */
  publish(workspaceId: string, blockId: string, section: string): Promise<PrReportPublishResult>
}
