import type { TaskSearchRepoScope, TaskSourceKind } from '@cat-factory/kernel'
import type { TaskSourceProvider, TaskSourceRegistry, TaskContent } from '@cat-factory/kernel'
import type { TaskRecord } from '@cat-factory/kernel'
import { markdownToText, buildExcerpt, MapSourceRegistry } from '@cat-factory/kernel'

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
 * Whether an imported task belongs to a repo scope, asked of the source that minted its
 * external id: a repo-backed provider (GitHub Issues, GitLab Issues) declares `repoScope` and
 * owns the comparison, because the id GRAMMAR and its case rules are the source's own.
 *
 * A source with no `repoScope` passes unfiltered, and that covers two different situations that
 * happen to want the same answer. A repo-LESS source (Jira, Linear) has no repository to be
 * narrowed to, so the scope simply does not apply to its rows. An UNREGISTERED source (a row
 * left behind by a provider this deployment no longer wires) has no rule available to judge it
 * by, and dropping a row a scope cannot evaluate would silently shrink the list rather than
 * narrow it: the reader would read the absence as "this service has no such issue".
 *
 * Passing the provider rather than looking it up here keeps this pure, and lets the caller
 * resolve each source ONCE for a whole list instead of per row.
 */
export function taskInRepoScope(
  record: Pick<TaskRecord, 'source' | 'externalId'>,
  scope: TaskSearchRepoScope,
  provider: TaskSourceProvider | undefined,
): boolean {
  const rules = provider?.repoScope
  if (!rules) return true
  return rules.matches(record.externalId, scope)
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
