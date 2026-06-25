import type { TaskSourceKind } from '@cat-factory/kernel'
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
