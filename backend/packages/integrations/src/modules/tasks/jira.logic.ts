import type {
  TaskDependencyLink,
  TaskSearchResult,
  TaskSourceDescriptor,
} from '@cat-factory/kernel'

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
  searchable: true,
}

/** Escape a user string for embedding inside a JQL double-quoted literal. */
function escapeJql(query: string): string {
  return query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the JQL for a free-text issue search: match the term across summary and
 * body (`text ~`), newest first. A bare key typed into the box still matches via
 * `text ~`, so the search box doubles as a quick "jump to issue".
 */
export function buildJiraSearchJql(query: string): string {
  return `text ~ "${escapeJql(query.trim())}" ORDER BY updated DESC`
}

interface JiraSearchResponse {
  issues?: {
    key?: string
    fields?: { summary?: string; status?: { name?: string } }
  }[]
}

/** Map a Jira search response into lean hits; URLs are the canonical `/browse/KEY`. */
export function parseJiraSearchResults(json: unknown, base: string): TaskSearchResult[] {
  const body = (json ?? {}) as JiraSearchResponse
  const cleanBase = base.replace(/\/+$/, '')
  const out: TaskSearchResult[] = []
  for (const issue of Array.isArray(body.issues) ? body.issues : []) {
    if (!issue.key) continue
    out.push({
      source: 'jira',
      externalId: issue.key,
      title: issue.fields?.summary ?? '(untitled)',
      url: `${cleanBase}/browse/${issue.key}`,
      status: issue.fields?.status?.name ?? '',
      excerpt: '',
    })
  }
  return out
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

/** Build the JQL that lists an epic's / parent's direct children, newest first. */
export function buildJiraChildrenJql(key: string): string {
  // `parent = KEY` matches both next-gen epic children and classic sub-tasks; the legacy
  // `"Epic Link" = KEY` covers classic-project epic children that don't use `parent`.
  const k = escapeJql(key.trim())
  return `(parent = "${k}" OR "Epic Link" = "${k}") ORDER BY created ASC`
}

/** Whether a Jira issue type name denotes an epic (case-insensitive). */
export function isJiraEpicType(issueTypeName: string | undefined): boolean {
  return !!issueTypeName && /epic/i.test(issueTypeName)
}

/** One entry of a Jira issue's `issuelinks` field (the shape we read). */
export interface JiraIssueLink {
  type?: { name?: string; inward?: string; outward?: string }
  inwardIssue?: { key?: string }
  outwardIssue?: { key?: string }
}

/**
 * Map a Jira issue's `issuelinks` onto normalized {@link TaskDependencyLink}s. Jira link
 * types are phrased from the perspective of the OTHER issue: an `inwardIssue` reached via
 * the type's `inward` phrase, an `outwardIssue` via the `outward` phrase. We classify by
 * the phrase text:
 *   - inward "is blocked by"   → this issue is `blockedBy` the inward issue
 *   - outward "blocks"         → this issue `blocks` the outward issue
 *   - inward "depends on"-ish  → `dependsOn`; its inverse → `blocks`-like is ignored
 * Anything we don't recognise as a blocking relation is recorded as `relates` (the
 * importer skips those for sequencing). Lenient: malformed entries are dropped.
 */
export function mapJiraIssueLinks(links: unknown): TaskDependencyLink[] {
  if (!Array.isArray(links)) return []
  const out: TaskDependencyLink[] = []
  const seen = new Set<string>()
  for (const raw of links as JiraIssueLink[]) {
    const inwardKey = raw?.inwardIssue?.key
    const outwardKey = raw?.outwardIssue?.key
    const inwardPhrase = (raw?.type?.inward ?? '').toLowerCase()
    const outwardPhrase = (raw?.type?.outward ?? '').toLowerCase()
    // The inward issue is reached via the inward phrase ("is blocked by" / "is depended on by").
    if (inwardKey) {
      const type: TaskDependencyLink['type'] = /block/.test(inwardPhrase)
        ? 'blockedBy'
        : /depend/.test(inwardPhrase)
          ? 'dependsOn'
          : 'relates'
      pushLink(out, seen, type, inwardKey)
    }
    // The outward issue is reached via the outward phrase ("blocks" / "depends on").
    if (outwardKey) {
      const type: TaskDependencyLink['type'] = /block/.test(outwardPhrase)
        ? 'blocks'
        : /depend/.test(outwardPhrase)
          ? // "this depends on outward" → this is blocked by the outward issue.
            'blockedBy'
          : 'relates'
      pushLink(out, seen, type, outwardKey)
    }
  }
  return out
}

function pushLink(
  out: TaskDependencyLink[],
  seen: Set<string>,
  type: TaskDependencyLink['type'],
  externalId: string,
): void {
  const key = `${type}:${externalId}`
  if (seen.has(key)) return
  seen.add(key)
  out.push({ type, externalId })
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
