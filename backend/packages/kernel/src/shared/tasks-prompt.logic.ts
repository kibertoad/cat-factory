import type { TaskComment } from '../domain/types'
import { buildExcerpt } from './markdown.logic'

const MAX_CONTEXT_COMMENTS = 5

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

function metadataLine(view: TaskContextView): string {
  const parts = [`Status: ${view.status || '(unknown)'}`, `Type: ${view.type || '(unknown)'}`]
  if (view.assignee) parts.push(`Assignee: ${view.assignee}`)
  if (view.priority) parts.push(`Priority: ${view.priority}`)
  if (view.labels.length) parts.push(`Labels: ${view.labels.join(', ')}`)
  return parts.join(' · ')
}

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
