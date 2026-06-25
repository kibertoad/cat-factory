// Port for "pull the repo's default branch into this block's PR branch and report whether it
// merged cleanly or conflicts". The human-testing gate's "pull latest main + redeploy" action
// calls this — and ONLY this — to decide whether it can just rebuild the env (clean merge /
// nothing to do) or must first escalate to a `conflict-resolver`. Modelled as a port so core
// stays free of GitHub specifics; the server implements it over `GitHubClient.mergeBranch`, and
// tests supply a fake.

/**
 * The outcome of merging the base branch into a block's PR branch:
 *  - `merged`   — a merge commit was created on the PR branch (the branch advanced).
 *  - `noop`     — the PR branch was already up to date with base (nothing to merge).
 *  - `conflict` — the merge conflicts; the caller escalates to a conflict-resolver.
 */
export type BranchUpdateOutcome = 'merged' | 'noop' | 'conflict'

export interface BranchUpdater {
  /**
   * Merge the repo default branch into the block's open PR head branch, server-side. Returns
   * the {@link BranchUpdateOutcome}. Throws if the block has no resolvable open PR/branch (the
   * caller gates on a PR existing before offering the action).
   */
  updateFromBase(workspaceId: string, blockId: string): Promise<BranchUpdateOutcome>
}
