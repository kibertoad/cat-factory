import type {
  TaskComment,
  TaskContent,
  TaskDependencyLink,
  TaskSearchResult,
  TaskSourceDescriptor,
} from '@cat-factory/kernel'

// Linear-specific pure logic, kept out of the provider so it is unit-testable
// without a live API: the connect-form descriptor, parsing an issue identifier out
// of user input, the GraphQL documents, and mapping an issue onto the structured
// {@link TaskContent}. Linear descriptions / comment bodies are already Markdown,
// so there is no ADF-style conversion (unlike Jira) — fields pass through normalized.

/** What the connect UI renders, and which credentials the provider needs. */
export const LINEAR_TASK_DESCRIPTOR: TaskSourceDescriptor = {
  source: 'linear',
  label: 'Linear',
  icon: 'i-lucide-square-kanban',
  credentialFields: [
    {
      key: 'apiKey',
      label: 'Personal API key',
      secret: true,
      placeholder: 'lin_api_…',
      help: 'Create one at linear.app → Settings → Security & access → Personal API keys',
    },
  ],
  refLabel: 'Issue identifier or URL',
  refPlaceholder: 'ENG-123  or  https://linear.app/acme/issue/ENG-123',
  searchable: true,
}

// ---- GraphQL operations ----------------------------------------------------

/**
 * Fetch a single issue with everything the structured {@link TaskContent} needs.
 * Linear's `issue(id:)` resolves the human identifier (`ENG-123`) as well as the
 * UUID, so the stored external id is a valid argument.
 */
export const LINEAR_ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    priority
    priorityLabel
    state { name type }
    assignee { name }
    labels { nodes { name } }
    parent { identifier }
    children { nodes { identifier } }
    comments { nodes { user { name } createdAt body } }
    relations { nodes { type relatedIssue { identifier } } }
    inverseRelations { nodes { type issue { identifier } } }
  }
}`

/** Free-text issue search (used to populate the import picker). */
export const LINEAR_SEARCH_ISSUES_QUERY = `query SearchIssues($term: String!) {
  searchIssues(term: $term, first: 20) {
    nodes { identifier title url state { name } }
  }
}`

/** Cheapest authenticated read, for the live "check setup" probe. */
export const LINEAR_VIEWER_QUERY = `query Viewer { viewer { name } }`

// ---- Response shapes (the slices we read) ----------------------------------

interface LinearIssueNode {
  identifier?: string
  title?: string
  description?: string | null
  url?: string
  priority?: number
  priorityLabel?: string | null
  state?: { name?: string; type?: string } | null
  assignee?: { name?: string } | null
  labels?: { nodes?: { name?: string }[] }
  parent?: { identifier?: string } | null
  children?: { nodes?: { identifier?: string }[] }
  comments?: { nodes?: LinearCommentNode[] }
  relations?: { nodes?: { type?: string; relatedIssue?: { identifier?: string } }[] }
  inverseRelations?: { nodes?: { type?: string; issue?: { identifier?: string } }[] }
}

interface LinearCommentNode {
  user?: { name?: string }
  createdAt?: string
  body?: string | null
}

/**
 * Resolve a Linear issue identifier from raw user input: a bare identifier
 * (`ENG-123`), or an `/issue/ENG-123` URL. The identifier is upper-cased (Linear
 * keys are canonically upper-case). Returns null when nothing parses.
 */
export function parseLinearRef(input: string): string | null {
  const trimmed = input.trim()
  const KEY = /[A-Za-z][A-Za-z0-9]*-\d+/
  if (new RegExp(`^${KEY.source}$`).test(trimmed)) return trimmed.toUpperCase()
  const issue = trimmed.match(new RegExp(`/issue/(${KEY.source})`))
  if (issue) return issue[1]!.toUpperCase()
  return null
}

/** Collapse runaway blank lines in already-Markdown prose. */
function normalizeMarkdown(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Map an issue's `relations` + `inverseRelations` onto normalized
 * {@link TaskDependencyLink}s. Linear models a "blocks" dependency as a single
 * relation with a direction: in `relations` THIS issue is the source (it `blocks`
 * the related issue); in `inverseRelations` it is the target (so it is `blockedBy`
 * the other issue). Non-blocking relation types (`related`/`duplicate`/`similar`)
 * are recorded as `relates` (the importer skips those for sequencing). Lenient:
 * malformed entries are dropped, and duplicates are de-duped.
 */
export function mapLinearRelations(issue: LinearIssueNode): TaskDependencyLink[] {
  const out: TaskDependencyLink[] = []
  const seen = new Set<string>()
  const push = (type: TaskDependencyLink['type'], externalId: string | undefined): void => {
    if (!externalId) return
    const key = `${type}:${externalId.toUpperCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ type, externalId: externalId.toUpperCase() })
  }
  for (const rel of issue.relations?.nodes ?? []) {
    const id = rel.relatedIssue?.identifier
    if (rel.type === 'blocks') push('blocks', id)
    else push('relates', id)
  }
  for (const rel of issue.inverseRelations?.nodes ?? []) {
    const id = rel.issue?.identifier
    if (rel.type === 'blocks') push('blockedBy', id)
    else push('relates', id)
  }
  return out
}

/** Map an `issue` GraphQL payload onto the structured {@link TaskContent}. */
export function mapLinearIssue(data: { issue?: LinearIssueNode | null }): TaskContent {
  const issue = data.issue
  if (!issue?.identifier) throw new Error('Linear returned no issue for the requested identifier')
  const childExternalIds = (issue.children?.nodes ?? [])
    .map((c) => c.identifier)
    .filter((id): id is string => !!id)
  const isEpic = childExternalIds.length > 0
  const comments: TaskComment[] = (issue.comments?.nodes ?? []).map((c) => ({
    author: c.user?.name ?? '',
    createdAt: c.createdAt ?? '',
    body: normalizeMarkdown(c.body),
  }))
  return {
    externalId: issue.identifier,
    url: issue.url ?? `https://linear.app/issue/${issue.identifier}`,
    title: issue.title ?? '(untitled)',
    status: issue.state?.name ?? '',
    // Linear has no distinct "issue type"; surface epic vs. plain issue.
    type: isEpic ? 'Epic' : 'Issue',
    assignee: issue.assignee?.name ?? null,
    priority: issue.priorityLabel ?? null,
    labels: (issue.labels?.nodes ?? []).map((l) => l.name ?? '').filter(Boolean),
    description: normalizeMarkdown(issue.description),
    comments,
    isEpic,
    parentExternalId: issue.parent?.identifier ?? null,
    childExternalIds,
    links: mapLinearRelations(issue),
  }
}

interface LinearSearchNode {
  identifier?: string
  title?: string
  url?: string
  state?: { name?: string } | null
}

/** Map a `searchIssues` payload onto lean {@link TaskSearchResult} hits. */
export function mapLinearSearchResults(data: {
  searchIssues?: { nodes?: LinearSearchNode[] }
}): TaskSearchResult[] {
  const nodes = data.searchIssues?.nodes ?? []
  const out: TaskSearchResult[] = []
  for (const node of nodes) {
    if (!node.identifier) continue
    out.push({
      source: 'linear',
      externalId: node.identifier,
      title: node.title ?? '(untitled)',
      url: node.url ?? `https://linear.app/issue/${node.identifier}`,
      status: node.state?.name ?? '',
      excerpt: '',
    })
  }
  return out
}
