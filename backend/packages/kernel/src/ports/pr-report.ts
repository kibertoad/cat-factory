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
 *
 * A multi-repo run resolves SEVERAL of these (see {@link PrVerificationReportPublisher.resolveTargets}),
 * one per pull request it opened, and each gets its own composed report.
 */
export interface PrReportTarget {
  /** The pull/merge request the report is written onto. */
  prNumber: number
  /** `owner/name` of the repo that PR lives in. */
  repo: string
  /** The VCS provider that repo lives on. */
  provider: VcsProvider
  /**
   * `own` for the task's own-service pull request — the only target a single-repo run has —
   * and `peer` for a connected involved service's repo (`Block.peerPullRequests`).
   *
   * The engine composes a DIFFERENT report for each: the sections that are statements about
   * the own-service repo (pre-PR validation, the reproduction proof, the `spec/` requirement
   * join) are withheld from a peer's report rather than copied onto it, since a peer repo's
   * checks were never the ones that ran. See the contracts' `prReportScopeSchema`.
   */
  role: 'own' | 'peer'
  /**
   * The involved service frame whose repo this is, when the recorded peer PR attributed one.
   * Null for the own-service target, and for a peer whose frame was not recorded.
   */
  frameId?: string | null
  /** The pull request's web URL, when known — what a peer report links back to. */
  url?: string | null
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
   * Resolve EVERY pull request the block's report should be published onto — the own-service
   * PR first, then one per peer repo the run opened a PR in — or an empty array when there is
   * nowhere to write yet (no recorded pull request, or no linked repo).
   *
   * The engine calls this FIRST: it short-circuits the compose for a run that has no PR (most
   * runs, for most of their life) and supplies the repo/provider/role each report states. Never
   * throws for an absent PR/repo; those are ordinary skips.
   *
   * Ordering is load-bearing: the own-service target is FIRST when it exists, because a peer
   * report points back at it and the engine reads it from this list rather than re-resolving.
   * A run whose peers opened PRs but whose own service did not yet returns peers only, and
   * their reports say the own-service PR is not open rather than naming one that isn't there.
   *
   * Resolving N peers must not cost N repo lookups: the adapter resolves the run's repo set in
   * ONE call and joins the recorded peer PRs onto it (the no-N+1 rule).
   */
  resolveTargets(workspaceId: string, blockId: string): Promise<PrReportTarget[]>
  /**
   * Upsert the engine-managed verification-report section on ONE resolved pull request.
   * `section` is the fully rendered markdown (human-readable prose + the fenced JSON block);
   * the adapter reads that PR's current body, splices the marked region, and writes it back
   * ONLY when it changed.
   *
   * `target` is passed in rather than re-resolved, because on a multi-repo run there is no
   * single "the block's PR" to re-derive: the caller composed a report FOR this target, and
   * re-resolving here is how the body written and the report written into it would come to
   * disagree about which repo they are about.
   *
   * Never throws for an absent PR / repo — those are ordinary skips (a run may open its PR on
   * a later step, or produce none at all). A transport failure MAY throw; the engine treats a
   * failed publish as best-effort bookkeeping and never fails a run over it.
   */
  publish(
    workspaceId: string,
    blockId: string,
    target: PrReportTarget,
    section: string,
  ): Promise<PrReportPublishResult>
}
