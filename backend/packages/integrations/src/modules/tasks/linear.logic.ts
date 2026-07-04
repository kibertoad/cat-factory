import type {
  IssueIntakeQuery,
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
  // Offers the "Connect with Linear" OAuth button (when the deployment configured a
  // Linear OAuth app); the personal-API-key field above stays as the manual fallback.
  oauth: true,
}

// ---- GraphQL operations ----------------------------------------------------

/** Largest page Linear allows on a connection, and the page we always request. */
const PAGE_SIZE = 100

/**
 * How many extra connection pages to walk per issue (children / comments), bounding
 * the per-import fan-out. Mirrors {@link JiraProvider}'s `CHILD_PAGE_CAP` — an epic
 * with up to ~2100 children/comments imports fully; beyond that it is truncated.
 */
export const LINEAR_PAGE_CAP = 20

/**
 * Fetch a single issue with everything the structured {@link TaskContent} needs.
 * Linear's `issue(id:)` resolves the human identifier (`ENG-123`) as well as the
 * UUID, so the stored external id is a valid argument. The `children` and `comments`
 * connections request the max page plus a `pageInfo` cursor so the provider can walk
 * the rest (Linear returns only the first page by default — see {@link LinearTaskProvider}).
 */
export const LINEAR_ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    priorityLabel
    state { name type }
    assignee { name }
    labels(first: ${PAGE_SIZE}) { nodes { name } }
    parent { identifier }
    children(first: ${PAGE_SIZE}) { nodes { identifier } pageInfo { hasNextPage endCursor } }
    comments(first: ${PAGE_SIZE}) { nodes { user { name } createdAt body } pageInfo { hasNextPage endCursor } }
    relations(first: ${PAGE_SIZE}) { nodes { type relatedIssue { identifier } } }
    inverseRelations(first: ${PAGE_SIZE}) { nodes { type issue { identifier } } }
  }
}`

/** One more page of an issue's child identifiers (the children-pagination walk). */
export const LINEAR_ISSUE_CHILDREN_QUERY = `query IssueChildren($id: String!, $after: String!) {
  issue(id: $id) {
    children(first: ${PAGE_SIZE}, after: $after) {
      nodes { identifier }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

/** One more page of an issue's comments (the comments-pagination walk). */
export const LINEAR_ISSUE_COMMENTS_QUERY = `query IssueComments($id: String!, $after: String!) {
  issue(id: $id) {
    comments(first: ${PAGE_SIZE}, after: $after) {
      nodes { user { name } createdAt body }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

/** Free-text issue search (used to populate the import picker). */
export const LINEAR_SEARCH_ISSUES_QUERY = `query SearchIssues($term: String!) {
  searchIssues(term: $term, first: 20) {
    nodes { identifier title url state { name } }
  }
}`

/**
 * Issue-intake predicate search. The predicates travel as an `IssueFilter`
 * variable (see {@link buildLinearIntakeFilter}); `sort` asks Linear for
 * oldest-created-first so the page window IS the oldest matching issues (a
 * client-side sort of a newest-first page would pick the oldest of the newest —
 * wrong for a backlog larger than one page). Nodes carry `createdAt` so the
 * mapper can enforce the ordering deterministically regardless.
 */
export const LINEAR_INTAKE_ISSUES_QUERY = `query IntakeIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, sort: [{ createdAt: { order: Ascending } }]) {
    nodes { identifier title url createdAt state { name } }
    pageInfo { hasNextPage endCursor }
  }
}`

/**
 * Bounded page walk for issue-intake overscan: the already-worked (excluded) issues
 * cluster at the front of the oldest-first results, so page through (bounded) rather
 * than let a first page full of them starve the pickup.
 */
export const LINEAR_INTAKE_PAGE_CAP = 5

/**
 * Compile an intake query's predicates onto a Linear `IssueFilter`: the team
 * scope, open-only (state type not completed/canceled), every label present
 * (one `labels.some` clause per label, AND-ed), and the title fragment as
 * `containsIgnoreCase`. Linear has no issue-type notion, so `issueType` is
 * ignored (teams label their bugs — the `labels` predicate covers it). The
 * already-worked exclusion list is not expressible on the human identifier;
 * the provider filters it from a bounded overscan (see the mapper).
 */
export function buildLinearIntakeFilter(query: IssueIntakeQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    state: { type: { nin: ['completed', 'canceled'] } },
  }
  if (query.board.linearTeamId) filter.team = { id: { eq: query.board.linearTeamId } }
  if (query.titleFragment) filter.title = { containsIgnoreCase: query.titleFragment }
  const labels = query.labels ?? []
  if (labels.length > 0) {
    filter.and = labels.map((label) => ({ labels: { some: { name: { eq: label } } } }))
  }
  return filter
}

/** One node of the intake `issues` connection (the slice we read). */
export interface LinearIntakeNode extends LinearSearchNode {
  createdAt?: string
}

/** One page of the intake `issues` connection (nodes + the cursor for the overscan walk). */
export interface LinearIntakePage {
  issues?: { nodes?: LinearIntakeNode[]; pageInfo?: LinearPageInfo | null }
}

/**
 * Map an intake `issues` payload onto lean hits: drop the excluded (already
 * worked) identifiers, order oldest-created-first, and cap at `limit`.
 */
export function mapLinearIntakeResults(
  data: { issues?: { nodes?: LinearIntakeNode[] } },
  limit: number,
  excludeExternalIds: string[] = [],
): TaskSearchResult[] {
  const excluded = new Set(excludeExternalIds.map((id) => id.toUpperCase()))
  const nodes = (data.issues?.nodes ?? []).filter(
    (node): node is LinearIntakeNode & { identifier: string } =>
      !!node.identifier && !excluded.has(node.identifier.toUpperCase()),
  )
  nodes.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  return nodes.slice(0, limit).map((node) => ({
    source: 'linear' as const,
    externalId: node.identifier,
    title: node.title ?? '(untitled)',
    url: node.url ?? `https://linear.app/issue/${node.identifier}`,
    status: node.state?.name ?? '',
    excerpt: '',
  }))
}

/** List the connection's teams (for the ticket-filing team picker). */
export const LINEAR_TEAMS_QUERY = `query Teams { teams(first: 250) { nodes { id name key } } }`

/** Cheapest authenticated read, for the live "check setup" probe. */
export const LINEAR_VIEWER_QUERY = `query Viewer { viewer { name } }`

// ---- Response shapes (the slices we read) ----------------------------------

/** A connection's cursor info, present on the paginated children/comments connections. */
export interface LinearPageInfo {
  hasNextPage?: boolean
  endCursor?: string | null
}

/** One page of an issue's child identifiers. */
export interface LinearChildrenPage {
  nodes?: { identifier?: string }[]
  pageInfo?: LinearPageInfo | null
}

/** One page of an issue's comments. */
export interface LinearCommentsPage {
  nodes?: LinearCommentNode[]
  pageInfo?: LinearPageInfo | null
}

interface LinearIssueNode {
  identifier?: string
  title?: string
  description?: string | null
  url?: string
  priorityLabel?: string | null
  state?: { name?: string; type?: string } | null
  assignee?: { name?: string } | null
  labels?: { nodes?: { name?: string }[] }
  parent?: { identifier?: string } | null
  children?: LinearChildrenPage
  comments?: LinearCommentsPage
  relations?: { nodes?: { type?: string; relatedIssue?: { identifier?: string } }[] }
  inverseRelations?: { nodes?: { type?: string; issue?: { identifier?: string } }[] }
}

interface LinearCommentNode {
  user?: { name?: string }
  createdAt?: string
  body?: string | null
}

/** Map one page of a `children` connection onto child identifiers (drops blanks). */
export function mapLinearChildIds(page: LinearChildrenPage | null | undefined): string[] {
  return (page?.nodes ?? []).map((c) => c.identifier).filter((id): id is string => !!id)
}

/** Map one page of a `comments` connection onto normalized {@link TaskComment}s. */
export function mapLinearComments(page: LinearCommentsPage | null | undefined): TaskComment[] {
  return (page?.nodes ?? []).map((c) => ({
    author: c.user?.name ?? '',
    createdAt: c.createdAt ?? '',
    body: normalizeMarkdown(c.body),
  }))
}

/**
 * Resolve a Linear issue identifier from raw user input: a bare identifier
 * (`ENG-123`), or a `linear.app/.../issue/ENG-123` URL. The identifier is
 * upper-cased (Linear keys are canonically upper-case). A URL is only accepted
 * when it is hosted on `linear.app` — mirroring `parseLinearDocRef`, so a foreign
 * URL that merely contains an `/issue/<key>`-looking path can't be mistaken for a
 * Linear reference. Returns null when nothing parses.
 */
export function parseLinearRef(input: string): string | null {
  const trimmed = input.trim()
  const KEY = /[A-Za-z][A-Za-z0-9]*-\d+/
  // A bare identifier (anything that is exactly a Linear key).
  if (new RegExp(`^${KEY.source}$`).test(trimmed)) return trimmed.toUpperCase()
  // Otherwise it must be a linear.app URL whose path carries an `/issue/<key>`.
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== 'linear.app') return null
  const issue = url.pathname.match(new RegExp(`/issue/(${KEY.source})`))
  return issue ? issue[1]!.toUpperCase() : null
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

/**
 * Map an `issue` GraphQL payload onto the structured {@link TaskContent}. Only the
 * FIRST page of the `children`/`comments` connections is reflected here; the provider
 * walks any further pages (see {@link LinearTaskProvider}) and appends them.
 */
export function mapLinearIssue(data: { issue?: LinearIssueNode | null }): TaskContent {
  const issue = data.issue
  if (!issue?.identifier) throw new Error('Linear returned no issue for the requested identifier')
  const childExternalIds = mapLinearChildIds(issue.children)
  const isEpic = childExternalIds.length > 0
  const comments = mapLinearComments(issue.comments)
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

/**
 * Project a fully-fetched {@link TaskContent} onto a lean {@link TaskSearchResult}, so the
 * exact-match path (a pasted identifier / URL resolved by {@link parseLinearRef}) can
 * surface the issue as a search hit alongside the free-text results.
 */
export function linearIssueSearchHit(content: TaskContent): TaskSearchResult {
  return {
    source: 'linear',
    externalId: content.externalId,
    title: content.title,
    url: content.url,
    status: content.status,
    excerpt: '',
  }
}

/** A Linear team, as offered in the ticket-filing team picker. */
export interface LinearTeam {
  id: string
  name: string
  key: string
}

/** Map a `teams` payload onto the picker shape (drops id-less nodes). */
export function mapLinearTeams(data: {
  teams?: { nodes?: { id?: string; name?: string; key?: string }[] }
}): LinearTeam[] {
  const out: LinearTeam[] = []
  for (const node of data.teams?.nodes ?? []) {
    if (!node.id) continue
    out.push({ id: node.id, name: node.name ?? node.id, key: node.key ?? '' })
  }
  return out
}
