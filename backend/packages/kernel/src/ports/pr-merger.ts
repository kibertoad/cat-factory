// Port for actually merging a block's pull request on the remote (GitHub). The
// execution engine calls this — and ONLY this — when a task should transition to
// `done`, so "done" provably means "the PR was merged" rather than a board-only
// status flip. Modelled as a port so core stays free of GitHub specifics; the
// worker implements it by resolving the block's repo target + open PR and calling
// `GitHubClient.mergePullRequest`, and tests supply a fake.

export interface PullRequestMerger {
  /**
   * Merge the open pull request recorded on `blockId` (from its `pullRequest`
   * ref). Resolves once the remote reports the merge succeeded. Throws if the
   * block has no PR, the merge is blocked (e.g. failing required checks, conflicts)
   * or the API call fails — the caller leaves the block awaiting a manual merge.
   */
  mergeForBlock(workspaceId: string, blockId: string): Promise<void>
}
