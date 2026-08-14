import type { RunBugHuntInput, TaskSourceState } from '@cat-factory/contracts'

// The pure half of BugHuntModal: what SCOPES a hunt. Extracted for the reason every `*.logic.ts`
// here is (a decision worth a test should not need a mounted component to reach), and this one
// carries the whole rule the surface exists to enforce: a repo-backed tracker hunts the
// repository of the service the bug will land in, and names no board of its own.

/**
 * Whether this tracker's board is the chosen service's repository rather than a choice.
 *
 * Read off the source's declared `repoBacked`, never its id: a deployment that registers its own
 * repo-backed source, or one running GitLab instead of GitHub, must behave identically, and a
 * source list compared here would be a second authority that drifts from the backend's.
 * An unresolved source (still loading, or one this workspace no longer offers) is NOT repo-backed:
 * the answer decides which control to render, and rendering none is the option a user cannot
 * correct.
 */
export function boardFromService(source: TaskSourceState | undefined): boolean {
  return source?.repoBacked === true
}

/**
 * The scan request, or null when the form does not yet name one.
 *
 * `board` is explicitly `null` for a repo-backed tracker rather than an empty string: the backend
 * REFUSES a board named for such a source instead of ignoring it, so the difference between "no
 * board to name" and "a board named as blank" has to survive this far. The container is required
 * either way: it is where an adopted bug lands, and on a repo-backed tracker it is also what
 * decides which repository is read at all.
 */
export function huntRequest(input: {
  source: TaskSourceState | undefined
  containerId: string | undefined
  board: string
  issueType: string
  labels: string
}): RunBugHuntInput | null {
  const { containerId } = input
  if (!input.source || !containerId) return null
  const fromService = boardFromService(input.source)
  const board = input.board.trim()
  if (!fromService && !board) return null
  const issueType = input.issueType.trim()
  const labels = input.labels
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
  return {
    containerId,
    board: fromService ? null : board,
    ...(issueType ? { issueType } : {}),
    ...(labels.length ? { labels } : {}),
  }
}
