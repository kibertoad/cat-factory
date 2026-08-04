import type {
  BugCandidate,
  IssueIntakeQuery,
  TaskDependencyLink,
  TaskSearchResult,
  TaskSourceDescriptor,
  TrackerBoard,
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

/** A well-formed Jira issue key (`PROJ-123`) — the only shape allowed into a JQL `IN` list. */
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/

/**
 * Build the JQL for an issue-intake predicate search: open issues
 * (`statusCategory != Done`) in the configured project matching every present
 * predicate, oldest first. All predicates are pushed into the query (including
 * the already-worked exclusion list, as `issuekey NOT IN`) so Jira does the
 * filtering — never fetch-all-then-filter. Excluded ids are validated against
 * the issue-key shape (and embedded unquoted, as JQL requires for keys), so a
 * malformed stored id can't break — or inject into — the query.
 */
export function buildJiraIntakeJql(query: IssueIntakeQuery): string {
  const clauses: string[] = []
  if (query.board.jiraProjectKey)
    clauses.push(`project = "${escapeJql(query.board.jiraProjectKey)}"`)
  clauses.push('statusCategory != Done')
  if (query.issueType) clauses.push(`issuetype = "${escapeJql(query.issueType)}"`)
  // `assignee IS EMPTY` is JQL's unassigned predicate — pushed down like every other, so a
  // hunt never pays for (or truncates on) issues somebody already owns.
  if (query.unassignedOnly) clauses.push('assignee IS EMPTY')
  for (const label of query.labels ?? []) clauses.push(`labels = "${escapeJql(label)}"`)
  if (query.titleFragment) clauses.push(`summary ~ "${escapeJql(query.titleFragment)}"`)
  const excluded = (query.excludeExternalIds ?? []).filter((id) => JIRA_KEY.test(id))
  if (excluded.length > 0) clauses.push(`issuekey NOT IN (${excluded.join(', ')})`)
  return `${clauses.join(' AND ')} ORDER BY created ASC`
}

/**
 * The issue fields a bug-hunt candidate needs, as ONE `fields=` selection. Everything the
 * ranking reasons over comes back in the same search response — there is deliberately no
 * per-issue detail fetch, which at 40 candidates would be 40 extra round trips against a
 * rate-limited API for data the search endpoint already returns.
 */
export const JIRA_CANDIDATE_FIELDS =
  'summary,description,status,issuetype,priority,labels,created,comment'

/** Cap on a candidate's rendered body; the ranking judges actionability, not the full trace. */
const MAX_CANDIDATE_DESCRIPTION_CHARS = 1_200

interface JiraCandidateResponse {
  issues?: {
    key?: string
    fields?: {
      summary?: string
      description?: unknown
      status?: { name?: string }
      issuetype?: { name?: string }
      priority?: { name?: string } | null
      labels?: string[]
      created?: string
      comment?: { total?: number; comments?: unknown[] }
    }
  }[]
}

/**
 * Map a candidate search response onto {@link BugCandidate} rows. The ADF description is
 * converted with the same {@link adfToMarkdown} the import path uses (so the ranking reads
 * the body a human would) and then truncated.
 *
 * `comment.total` is Jira's own count and is preferred over the returned array's length,
 * which is only the page the `fields` selection happened to include — reporting "2 comments"
 * for a 40-comment argument would understate exactly the contested bugs worth flagging.
 */
export function parseJiraBugCandidates(json: unknown, base: string): BugCandidate[] {
  const body = (json ?? {}) as JiraCandidateResponse
  const cleanBase = base.replace(/\/+$/, '')
  const out: BugCandidate[] = []
  for (const issue of Array.isArray(body.issues) ? body.issues : []) {
    if (!issue.key) continue
    const f = issue.fields ?? {}
    out.push({
      source: 'jira',
      externalId: issue.key,
      title: f.summary ?? '(untitled)',
      url: `${cleanBase}/browse/${issue.key}`,
      status: f.status?.name ?? '',
      type: f.issuetype?.name ?? '',
      priority: f.priority?.name ?? null,
      labels: Array.isArray(f.labels) ? f.labels : [],
      description: adfToMarkdown(f.description).trim().slice(0, MAX_CANDIDATE_DESCRIPTION_CHARS),
      createdAt: f.created ?? '',
      commentCount:
        typeof f.comment?.total === 'number' ? f.comment.total : (f.comment?.comments?.length ?? 0),
    })
  }
  return out
}

interface JiraProjectsResponse {
  values?: { key?: string; name?: string }[]
}

/**
 * Map the paginated project-search response onto boards. A Jira board scope is the project
 * KEY (what `buildJiraIntakeJql` puts in `project = …`), so `id` and `key` are the same value
 * here — the picker still shows both because `name` alone is ambiguous across similarly-named
 * projects, which is the whole reason the key exists.
 */
export function parseJiraBoards(json: unknown): TrackerBoard[] {
  const body = (json ?? {}) as JiraProjectsResponse
  const out: TrackerBoard[] = []
  for (const project of Array.isArray(body.values) ? body.values : []) {
    if (!project.key) continue
    out.push({ id: project.key, name: project.name ?? project.key, key: project.key })
  }
  return out
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
 *   - inward "is blocked by"      → this issue is `blockedBy` the inward issue
 *   - inward "is depended on by"  → the inward issue depends on this → this `blocks` it
 *   - outward "blocks"            → this issue `blocks` the outward issue
 *   - outward "depends on"        → this issue is `blockedBy` the outward issue
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
    // "is blocked by X" → this is blockedBy X; "is depended on by X" → X depends on this, so
    // this BLOCKS X (NOT `dependsOn` — that direction is the exact reverse).
    if (inwardKey) {
      const type: TaskDependencyLink['type'] = /block/.test(inwardPhrase)
        ? 'blockedBy'
        : /depend/.test(inwardPhrase)
          ? 'blocks'
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
  const renderer = createAdfRenderer()
  const out = renderer.render(node as AdfNode)
  const body = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // A cap that stays quiet is indistinguishable from a document that simply ended there, and this
  // text is read by people and by models: a reader who cannot see the cut concludes the rest was
  // considered and found empty. Both callers want the note: an issue description folded into a
  // prompt, and a webhook comment whose commands may be past the cut.
  return renderer.truncated() ? `${body}\n\n${ADF_TRUNCATION_NOTE}`.trim() : body
}

/** What {@link adfToMarkdown} appends when it stopped short of the end of the document. */
export const ADF_TRUNCATION_NOTE =
  '[truncated: this document is larger or more deeply nested than the renderer will walk]'

/**
 * How much of one document the walk will render.
 *
 * ADF arrives from two directions and only one of them is a document a person typed: an issue
 * body read on the import path, and a comment body on the inbound webhook path, where the JSON is
 * whatever the delivery carried. A recursive descent over unbounded, externally-authored
 * structure is an unbounded stack and unbounded CPU, and on the Worker that is a request budget
 * rather than a machine. Both caps are far above anything Jira's own editor produces (its comment
 * field is capped near 32k characters), so a real document is unaffected and only a pathological
 * one is stopped.
 */
const MAX_ADF_NODES = 20_000
const MAX_ADF_DEPTH = 100

interface AdfNode {
  type?: string
  text?: string
  content?: unknown[]
  attrs?: Record<string, unknown>
}

/**
 * A single document's walk, with its budget held per call rather than in module state. Two
 * renders can be in flight at once (a Worker isolate serves concurrent requests), and a shared
 * counter would let one document's size truncate another's.
 */
function createAdfRenderer(): { render(node: AdfNode): string; truncated(): boolean } {
  let remaining = MAX_ADF_NODES
  let truncated = false

  /** Spend one node of the budget, or report that the walk must stop here. */
  const admit = (depth: number): boolean => {
    if (depth > MAX_ADF_DEPTH || remaining <= 0) {
      truncated = true
      return false
    }
    remaining -= 1
    return true
  }

  /** Render a node's children, concatenated. */
  const renderChildren = (node: AdfNode, depth: number): string => {
    if (!Array.isArray(node.content)) return ''
    return node.content.map((child) => render(child as AdfNode, depth + 1)).join('')
  }

  /** Render one node's inline text (no block markers). */
  const renderInline = (node: AdfNode, depth: number): string => {
    if (!admit(depth)) return ''
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'hardBreak') return ' '
    const atom = atomicText(node)
    if (atom !== null) return atom
    return renderInlineChildren(node, depth)
  }

  /**
   * The inline text of a node's CHILDREN, for a container the caller has already admitted
   * (a heading, a list item, a code block). Taking the children rather than the node keeps one
   * node charged to the budget once, whichever arm reaches it.
   */
  const renderInlineChildren = (node: AdfNode, depth: number): string => {
    if (!Array.isArray(node.content)) return ''
    return node.content.map((child) => renderInline(child as AdfNode, depth + 1)).join('')
  }

  const render = (node: AdfNode, depth = 0): string => {
    if (typeof node !== 'object' || node === null) return ''
    if (!admit(depth)) return ''
    switch (node.type) {
      case 'text':
        return node.text ?? ''
      case 'hardBreak':
        return '\n'
      case 'mention':
      case 'status':
      case 'emoji':
      case 'inlineCard':
        return atomicText(node) ?? ''
      case 'blockCard':
        return `${atomicText(node) ?? ''}\n\n`
      case 'paragraph':
        return `${renderChildren(node, depth)}\n\n`
      case 'heading': {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1) || 1, 1), 3)
        return `${'#'.repeat(level)} ${renderInlineChildren(node, depth).trim()}\n\n`
      }
      case 'bulletList':
      case 'orderedList':
        return `${renderChildren(node, depth)}\n`
      case 'listItem':
        return `- ${renderInlineChildren(node, depth).trim()}\n`
      case 'codeBlock':
        return `\`\`\`\n${renderInlineChildren(node, depth)}\n\`\`\`\n\n`
      case 'blockquote':
        return renderChildren(node, depth)
      default:
        // 'doc', 'mediaGroup', panels, tables, unknown marks: recurse into content.
        return renderChildren(node, depth)
    }
  }

  return { render: (node) => render(node), truncated: () => truncated }
}

/**
 * The text of a LEAF node that carries it in `attrs` instead of in children: a mention, an
 * emoji, a status lozenge, or a smart link (a URL Jira's editor upgrades to a card).
 *
 * They need naming explicitly because the default arm above walks CONTENT, and these have none,
 * so an unlisted one renders as nothing at all rather than as something degraded, dropping a
 * name, a link or a state out of the middle of a sentence with no trace that it was there.
 *
 * `null` means "not one of these types" and is what sends `renderInline` on to walk children;
 * a recognised type whose attrs carry nothing usable answers `''` instead. Collapsing the two
 * would be harmless today only because every type here is childless, which is a fact about
 * today's ADF rather than about this function.
 */
function atomicText(node: AdfNode): string | null {
  const attrs = node.attrs ?? {}
  const text = typeof attrs.text === 'string' ? attrs.text : null
  switch (node.type) {
    case 'mention':
    case 'status':
      return text ?? ''
    case 'emoji':
      return text ?? (typeof attrs.shortName === 'string' ? attrs.shortName : '')
    case 'inlineCard':
    case 'blockCard':
      // A smart link carries its target as either a bare `url` or an embedded JSON-LD `data`
      // object, depending on whether Jira has resolved the card yet. Reading only the first
      // renders the unresolved half as nothing, which is the same silent mid-sentence loss the
      // atoms above are listed to prevent.
      return typeof attrs.url === 'string' ? attrs.url : (smartLinkUrl(attrs.data) ?? '')
    default:
      return null
  }
}

/** The `url` of a smart link's embedded JSON-LD payload, when it carries one. */
function smartLinkUrl(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const url = (data as { url?: unknown }).url
  return typeof url === 'string' ? url : null
}
