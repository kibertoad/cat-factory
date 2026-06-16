import type { TaskSourceKind, TaskComment } from '../../domain/types'
import type { TaskSourceProvider, TaskSourceRegistry, TaskContent } from '../../ports/task-source'
import type { TaskRecord } from '../../ports/task-repositories'
import { markdownToText, buildExcerpt } from '../../shared/markdown.logic'

// Source-agnostic helpers shared by every task source: a trivial provider
// registry, deriving a plain-text excerpt from an issue, and rendering an issue
// into the compact Markdown section fed to agents as context. Providers normalize
// their description/comment bodies to lightweight Markdown so these stay
// independent of any one source's format. Kept pure for easy testing.

/** A trivial in-memory provider registry built from the wired providers. */
export class MapTaskSourceRegistry implements TaskSourceRegistry {
  private readonly byKind: Map<TaskSourceKind, TaskSourceProvider>

  constructor(providers: TaskSourceProvider[]) {
    this.byKind = new Map(providers.map((p) => [p.kind, p]))
  }

  get(kind: TaskSourceKind): TaskSourceProvider | undefined {
    return this.byKind.get(kind)
  }

  list(): TaskSourceProvider[] {
    return [...this.byKind.values()]
  }
}

/** The most recent comments to fold into context (newest, capped). */
const MAX_CONTEXT_COMMENTS = 5

/** A short plain-text excerpt of an issue: its summary + the start of its description. */
export function buildTaskExcerpt(content: TaskContent | TaskRecord, max = 280): string {
  const description = markdownToText(content.description)
  const lead = description ? `${content.title} — ${description}` : content.title
  return buildExcerpt(lead, max)
}

/** The plain shape the prompt renderer consumes (decoupled from the ports). */
export interface TaskContextView {
  key: string
  url: string
  title: string
  status: string
  type: string
  assignee: string | null
  priority: string | null
  labels: string[]
  description: string
  comments: TaskComment[]
}

/** The one-line metadata header (status / type / assignee / priority / labels). */
function metadataLine(view: TaskContextView): string {
  const parts = [`Status: ${view.status || '(unknown)'}`, `Type: ${view.type || '(unknown)'}`]
  if (view.assignee) parts.push(`Assignee: ${view.assignee}`)
  if (view.priority) parts.push(`Priority: ${view.priority}`)
  if (view.labels.length) parts.push(`Labels: ${view.labels.join(', ')}`)
  return parts.join(' · ')
}

/**
 * Render an issue into a compact Markdown block for the agent prompt: a titled
 * header with its URL, a metadata line, the description, then the most recent
 * comments (capped, each truncated) so the section stays bounded.
 */
export function renderTaskContext(view: TaskContextView): string {
  const lines = [`### [${view.key}] ${view.title} (${view.url})`, metadataLine(view)]
  const description = view.description.trim()
  if (description) lines.push('', description)
  const recent = view.comments.slice(-MAX_CONTEXT_COMMENTS)
  if (recent.length) {
    lines.push('', 'Recent comments:')
    for (const c of recent) {
      const who = c.author || 'unknown'
      const when = c.createdAt ? ` (${c.createdAt.slice(0, 10)})` : ''
      lines.push(`- ${who}${when}: ${buildExcerpt(c.body, 200)}`)
    }
  }
  return lines.join('\n')
}
