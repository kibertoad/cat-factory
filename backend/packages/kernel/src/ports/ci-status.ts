// Port for reading a block's CI status — the GitHub check runs for the head
// commit(s) of the pull request(s) an implementation step opened. The execution
// engine's `ci` step polls this between durable sleeps to decide whether CI is
// green (advance), still running (keep polling) or failing (dispatch a CI-fixer).
// Modelled as a port so core stays free of GitHub specifics; the worker resolves
// the block's repo target(s) + PR branch head(s) and calls `GitHubClient.listCheckRuns`.
//
// Multi-repo (service-connections phase 4): a cross-service task opens ONE PR per
// changed repo (own-service PR + peer-service PRs). The report carries a per-PR
// entry, own-service first, so the gate aggregates the verdict across every PR and
// names the failing repo(s). A single-repo block has exactly one entry.

/** One CI check for a PR head commit, flattened from the GitHub check-run shape. */
export interface CiCheck {
  name: string
  /** GitHub check status: 'queued' | 'in_progress' | 'completed'. */
  status: string
  /** GitHub conclusion when completed: 'success' | 'failure' | 'neutral' | … (null while running). */
  conclusion: string | null
  /** The check run's GitHub web URL (`html_url`), so the gate UI can link to its logs. */
  url?: string | null
}

/** The CI status of ONE of a block's pull requests (own-service or a peer-service repo). */
export interface RepoCiStatus {
  /** The repo (owner/name) whose PR head these checks are for. */
  repo: string
  /** The PR head commit; null when that repo has no resolvable PR head. */
  headSha: string | null
  /** The check runs reported for `headSha` (empty when none are configured/registered yet). */
  checks: CiCheck[]
}

export interface CiStatusReport {
  /**
   * Per-PR CI status across ALL of the block's pull requests — own-service PR first,
   * then any peer-service PRs (multi-repo). Empty when the block has no resolvable PR
   * (the engine treats that as "nothing to gate"). A single-repo block has one entry.
   */
  repos: RepoCiStatus[]
}

export interface CiStatusProvider {
  /**
   * Resolve the head commit of every PR the block opened (own-service + peers) and
   * list each one's CI check runs. Returns `{ repos: [] }` when the block has no
   * resolvable PR branch yet (the engine treats this as "nothing to gate").
   */
  getStatus(workspaceId: string, blockId: string): Promise<CiStatusReport>
}
