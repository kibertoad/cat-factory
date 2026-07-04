// Port for "can this block's PR(s) be merged into their base, or do they conflict?".
// The execution engine's `conflicts` gate calls this — and ONLY this — to decide
// whether to dispatch the conflict-resolver before the merge step. Modelled as a
// port so core stays free of GitHub specifics; the worker implements it against
// each PR's lazily-computed `mergeable`/`mergeable_state`, and tests supply a fake.
//
// Multi-repo (service-connections phase 4): a cross-service task opens ONE PR per
// changed repo. The report carries a per-PR entry (own-service first) so the gate
// can detect a conflict on ANY of them and dispatch a single-repo conflict-resolver
// at the first conflicted repo.

/**
 * The normalised mergeability of a PR:
 *  - `mergeable`  — merges cleanly into its base (nothing to resolve).
 *  - `conflicted` — conflicts with its base and needs resolution.
 *  - `unknown`    — GitHub has not finished computing mergeability yet (it is
 *                   computed asynchronously), so the caller should poll again.
 */
export type MergeabilityVerdict = 'mergeable' | 'conflicted' | 'unknown'

/** The mergeability of ONE of a block's pull requests (own-service or a peer-service repo). */
export interface RepoMergeability {
  /** The repo (owner/name) this PR is in. */
  repo: string
  /** The involved-service frame whose repo this is; absent for the own-service PR. */
  frameId?: string
  /** The PR head commit; null when no open PR/branch is resolved. */
  headSha: string | null
  /** The mergeability verdict; see {@link MergeabilityVerdict}. */
  verdict: MergeabilityVerdict
}

export interface MergeabilityReport {
  /**
   * Per-PR mergeability across ALL of the block's pull requests — own-service PR
   * first, then any peer-service PRs. Empty when the block has no resolvable PR (the
   * engine treats that as "nothing to gate"). A single-repo block has one entry.
   */
  repos: RepoMergeability[]
}

export interface PullRequestMergeabilityProvider {
  /**
   * Resolve every PR the block opened (own-service + peers) and report whether each
   * merges cleanly into its base. Returns `{ repos: [] }` when no PR/branch is
   * resolved — the engine treats that as "nothing to gate" and advances. A `RepoMergeability`
   * with verdict `unknown` (GitHub still computing) keeps the gate polling.
   */
  getMergeability(workspaceId: string, blockId: string): Promise<MergeabilityReport>
}
