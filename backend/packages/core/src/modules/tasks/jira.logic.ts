import type { TaskSourceDescriptor } from '../../domain/types'

// Jira-specific pure logic, kept out of the worker so it is unit-testable
// without a live site: parsing an issue key out of user input and converting an
// issue's Atlassian Document Format (ADF) body into the lightweight Markdown the
// generic excerpt/prompt logic consumes. The base-URL guard is shared with
// Confluence (see ../../shared/atlassian.logic); the fetch itself lives in the
// worker's JiraProvider.

/** What the connect UI renders, and which credentials the provider needs. */
export const JIRA_DESCRIPTOR: TaskSourceDescriptor = {
  source: 'jira',
  label: 'Jira',
  icon: 'i-lucide-square-check',
  credentialFields: [
    {
      key: 'baseUrl',
      label: 'Site URL',
      placeholder: 'https://your-team.atlassian.net',
      help: 'e.g. https://your-team.atlassian.net',
    },
    { key: 'accountEmail', label: 'Account email', placeholder: 'you@company.com' },
    {
      key: 'apiToken',
      label: 'API token',
      secret: true,
      placeholder: 'Paste a Jira API token',
      help: 'Create one at id.atlassian.com → Security → API tokens',
    },
  ],
  refLabel: 'Issue key or URL',
  refPlaceholder: 'PROJ-123  or  https://…/browse/PROJ-123',
}

/**
 * Resolve a Jira issue key from raw user input: a bare key (`PROJ-123`), a
 * `/browse/PROJ-123` URL, or the `selectedIssue=PROJ-123` / `/issues/PROJ-123`
 * board URL forms. The key is upper-cased (Jira keys are case-insensitive on
 * input but canonically upper-case). Returns null when nothing parses.
 */
export function parseJiraRef(input: string): string | null {
  const trimmed = input.trim()
  const KEY = /[A-Za-z][A-Za-z0-9]+-\d+/
  if (new RegExp(`^${KEY.source}$`).test(trimmed)) return trimmed.toUpperCase()
  const browse = trimmed.match(new RegExp(`/browse/(${KEY.source})`))
  if (browse) return browse[1]!.toUpperCase()
  const selected = trimmed.match(new RegExp(`[?&]selectedIssue=(${KEY.source})`))
  if (selected) return selected[1]!.toUpperCase()
  const issues = trimmed.match(new RegExp(`/issues/(${KEY.source})`))
  if (issues) return issues[1]!.toUpperCase()
  return null
}

/**
 * Convert an Atlassian Document Format node tree into lightweight Markdown: the
 * same `#`/`##`/`###` headings, `- ` list items and blank-line block boundaries
 * the generic excerpt/prompt logic consumes. ADF is a JSON document
 * (`{ type: 'doc', content: [...] }`); we walk it defensively so a missing or
 * unexpected node yields '' rather than throwing — Jira fields are sometimes
 * null or a plain string on older issues.
 */
export function adfToMarkdown(node: unknown): string {
  if (node == null) return ''
  // Older issues / some fields come back as a plain string already.
  if (typeof node === 'string') return node.trim()
  if (typeof node !== 'object') return ''
  const out = renderNode(node as AdfNode)
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface AdfNode {
  type?: string
  text?: string
  content?: unknown[]
  attrs?: Record<string, unknown>
}

/** Render a node's children, concatenated. */
function renderChildren(node: AdfNode): string {
  if (!Array.isArray(node.content)) return ''
  return node.content.map((child) => renderNode(child as AdfNode)).join('')
}

/** Render the inline text of a node (no block markers), for headings/list items. */
function renderInline(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return ' '
  return Array.isArray(node.content)
    ? node.content.map((child) => renderInline(child as AdfNode)).join('')
    : ''
}

function renderNode(node: AdfNode): string {
  if (typeof node !== 'object' || node === null) return ''
  switch (node.type) {
    case 'text':
      return node.text ?? ''
    case 'hardBreak':
      return '\n'
    case 'paragraph':
      return `${renderChildren(node)}\n\n`
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1) || 1, 1), 3)
      return `${'#'.repeat(level)} ${renderInline(node).trim()}\n\n`
    }
    case 'bulletList':
    case 'orderedList':
      return `${renderChildren(node)}\n`
    case 'listItem':
      return `- ${renderInline(node).trim()}\n`
    case 'codeBlock':
      return `\`\`\`\n${renderInline(node)}\n\`\`\`\n\n`
    case 'blockquote':
      return renderChildren(node)
    default:
      // 'doc', 'mediaGroup', panels, tables, unknown marks: recurse into content.
      return renderChildren(node)
  }
}
