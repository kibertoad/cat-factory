// Port for reading a block's CI status — the GitHub check runs for the head
// commit of the pull request an implementation step opened. The execution
// engine's `ci` step polls this between durable sleeps to decide whether CI is
// green (advance), still running (keep polling) or failing (dispatch a CI-fixer).
// Modelled as a port so core stays free of GitHub specifics; the worker resolves
// the block's repo target + PR branch head and calls `GitHubClient.listCheckRuns`.

/** One CI check for the head commit, flattened from the GitHub check-run shape. */
export interface CiCheck {
  name: string
  /** GitHub check status: 'queued' | 'in_progress' | 'completed'. */
  status: string
  /** GitHub conclusion when completed: 'success' | 'failure' | 'neutral' | … (null while running). */
  conclusion: string | null
  /** The check run's GitHub web URL (`html_url`), so the gate UI can link to its logs. */
  url?: string | null
}

export interface CiStatusReport {
  /** The PR head commit whose checks these are; null when no PR/branch resolved. */
  headSha: string | null
  /** The check runs reported for `headSha` (empty when none are configured/registered yet). */
  checks: CiCheck[]
}

export interface CiStatusProvider {
  /**
   * Resolve the head commit of the block's open PR and list its CI check runs.
   * Returns `{ headSha: null, checks: [] }` when the block has no resolvable PR
   * branch yet (the engine treats this as "nothing to gate").
   */
  getStatus(workspaceId: string, blockId: string): Promise<CiStatusReport>
}
