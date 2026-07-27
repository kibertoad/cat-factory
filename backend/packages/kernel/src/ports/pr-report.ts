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

import type { VcsProvider } from '../domain/vcs-types.js'

/** Why a publish did nothing, when it didn't publish. */
export type PrReportSkipReason =
  /** The block has no recorded pull request yet (nothing to write onto). */
  | 'no_pull_request'
  /** The block's repo could not be resolved (no linked repo projection row). */
  | 'no_repo'
  /** The PR body already carried exactly this section — no remote write was made. */
  | 'unchanged'

/**
 * Where a block's report would go, resolved by the adapter (which owns "which PR / which
 * repo / which provider" — the engine has no VCS vocabulary of its own).
 *
 * The composer needs this BEFORE it renders, because the report states which repo and provider
 * the run targeted. Deriving those from the run's own dispatch diagnostics instead would be a
 * different question with a different answer: diagnostics record the MOST RECENT dispatch,
 * which on a multi-repo task is a peer repo, not the repo whose PR is being written to.
 */
export interface PrReportTarget {
  /** The pull/merge request the report is written onto. */
  prNumber: number
  /** `owner/name` of the repo that PR lives in. */
  repo: string
  /** The VCS provider that repo lives on. */
  provider: VcsProvider
}

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
   * Resolve where the block's report would be published, or `null` when there is nowhere to
   * write it yet (no recorded pull request, or no linked repo). The engine calls this FIRST —
   * it both short-circuits the compose for a run that has no PR and supplies the repo/provider
   * the report states. Never throws for an absent PR/repo; those are ordinary skips.
   */
  resolveTarget(workspaceId: string, blockId: string): Promise<PrReportTarget | null>
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
