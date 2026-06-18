// Port for "can this block's PR be merged into its base, or does it conflict?".
// The execution engine's `conflicts` gate calls this — and ONLY this — to decide
// whether to dispatch the conflict-resolver before the merge step. Modelled as a
// port so core stays free of GitHub specifics; the worker implements it against
// the PR's lazily-computed `mergeable`/`mergeable_state`, and tests supply a fake.

/**
 * The normalised mergeability of a PR:
 *  - `mergeable`  — merges cleanly into its base (nothing to resolve).
 *  - `conflicted` — conflicts with its base and needs resolution.
 *  - `unknown`    — GitHub has not finished computing mergeability yet (it is
 *                   computed asynchronously), so the caller should poll again.
 */
export type MergeabilityVerdict = 'mergeable' | 'conflicted' | 'unknown'

export interface MergeabilityReport {
  /** The PR head commit these refer to; null when no open PR/branch is resolved. */
  headSha: string | null
  /** The mergeability verdict; see {@link MergeabilityVerdict}. */
  verdict: MergeabilityVerdict
}

export interface PullRequestMergeabilityProvider {
  /**
   * Resolve the block's open PR and report whether it merges cleanly into its base.
   * Returns `headSha: null` (verdict `unknown`) when no PR/branch is resolved — the
   * engine treats that as "nothing to gate" and advances. Returns `unknown` with a
   * head sha while GitHub is still computing mergeability, so the gate re-polls.
   */
  getMergeability(workspaceId: string, blockId: string): Promise<MergeabilityReport>
}
