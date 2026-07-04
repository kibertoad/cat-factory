import type { PullRequestRef } from '../domain/types.js'

// Port for actually merging a block's pull request(s) on the remote (GitHub). The
// execution engine calls this — and ONLY this — when a task should transition to
// `done`, so "done" provably means "the PR(s) were merged" rather than a board-only
// status flip. Modelled as a port so core stays free of GitHub specifics; the
// worker implements it by resolving the block's repo target + open PR and calling
// `GitHubClient.mergePullRequest`, and tests supply a fake.
//
// Multi-repo (service-connections phase 4): a cross-service task opens ONE PR per
// changed repo. The engine computes the merge order (provider-before-consumer) and
// hands the ordered list here; the impl merges them sequentially, stopping at the
// first failure and reporting which merged and which did not — cross-repo merges
// cannot be atomic, so a mid-sequence failure leaves a partially-merged task the
// engine surfaces for a human to finish or revert.

/** One pull request in a block's merge sequence (own-service or a peer-service repo). */
export interface MergePrEntry {
  /** The repo (owner/name) the PR is in; absent ⇒ the block's own-service repo. */
  repo?: string
  /** The involved-service frame whose repo this is; absent for the own-service PR. */
  frameId?: string
  /** The PR ref (number + branch) to merge. */
  ref: PullRequestRef
}

/** The outcome of merging a block's ordered PR list, stopping at the first failure. */
export interface MergeAllOutcome {
  /** The PRs that merged successfully, in the order they were merged. */
  merged: MergePrEntry[]
  /**
   * The first PR whose merge FAILED (which stops the sequence), with the error; null
   * when every PR merged. Any PRs after this one in the order are left unmerged.
   */
  failed: { entry: MergePrEntry; error: string } | null
  /** The PRs left unmerged because an earlier one in the order failed (excludes `failed`). */
  skipped: MergePrEntry[]
}

export interface PullRequestMerger {
  /**
   * Merge the given pull requests (own-service + peers) into their bases in the given
   * order, stopping at the FIRST failure. Deletes each merged work branch (best-effort).
   * Returns which merged and which did not — the engine flips the block `done` only when
   * every PR merged, and otherwise leaves it `blocked` with a notification enumerating the
   * split. Passing a single-entry list is the ordinary single-repo merge.
   */
  mergePullRequests(
    workspaceId: string,
    blockId: string,
    prs: MergePrEntry[],
  ): Promise<MergeAllOutcome>
}
