import type { TaskSearchRepoScope, TaskSourceKind } from '@cat-factory/kernel'
import type { TaskSourceProvider, TaskSourceRegistry, TaskContent } from '@cat-factory/kernel'
import type { TaskRecord } from '@cat-factory/kernel'
import { markdownToText, buildExcerpt, MapSourceRegistry } from '@cat-factory/kernel'
import { parseGitHubIssueExternalId } from './github-issues.logic.js'

export type { TaskContextView } from '@cat-factory/kernel'
export { renderTaskContext } from '@cat-factory/kernel'

// Source-agnostic helpers shared by every task source: a trivial provider
// registry, deriving a plain-text excerpt from an issue, and rendering an issue
// into the compact Markdown section fed to agents as context. Providers normalize
// their description/comment bodies to lightweight Markdown so these stay
// independent of any one source's format. Kept pure for easy testing.

/** A trivial in-memory provider registry built from the wired providers. */
export class MapTaskSourceRegistry
  extends MapSourceRegistry<TaskSourceKind, TaskSourceProvider>
  implements TaskSourceRegistry {}

/** A short plain-text excerpt of an issue: its summary + the start of its description. */
export function buildTaskExcerpt(content: TaskContent | TaskRecord, max = 280): string {
  const description = markdownToText(content.description)
  const lead = description ? `${content.title} — ${description}` : content.title
  return buildExcerpt(lead, max)
}

/**
 * Whether an imported task belongs to a repo scope. Only GitHub issues carry a
 * repo (their `owner/repo#number` external id), so a repo-less source (Jira,
 * Linear) always passes — the scope narrows the GitHub view without hiding
 * trackers that have no repo notion. Matching is case-insensitive (GitHub
 * owner/repo names are), mirroring the `repo:owner/name` search qualifier. A
 * GitHub id that doesn't parse (a stale/hand-edited row) is treated as
 * out-of-scope rather than leaking into every repo's list.
 */
export function taskInRepoScope(
  record: Pick<TaskRecord, 'source' | 'externalId'>,
  scope: TaskSearchRepoScope,
): boolean {
  if (record.source !== 'github') return true
  const parts = parseGitHubIssueExternalId(record.externalId)
  if (!parts) return false
  return (
    parts.owner.toLowerCase() === scope.owner.toLowerCase() &&
    parts.repo.toLowerCase() === scope.repo.toLowerCase()
  )
}

/**
 * Read a numeric HTTP status off a thrown error, if it carries one. Both the
 * GitHub (`GitHubApiError`) and Jira (`JiraApiError`) clients expose a `status`
 * field; the setup-check probes duck-type it (rather than importing those classes
 * across the layer boundary) to classify auth/permission/transport failures.
 */
export function httpStatusOf(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}
