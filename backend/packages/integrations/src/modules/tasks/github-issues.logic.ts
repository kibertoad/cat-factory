import type {
  IssueIntakeQuery,
  TaskDependencyLink,
  TaskSearchRepoScope,
  TaskSourceDescriptor,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { repoIssueBugCandidateMapper, repoRefsToBoards } from './repo-issues.logic.js'
import type { TaskSourceReadReason } from '@cat-factory/contracts'

// GitHub-issues task-source pure logic, kept out of the worker so it is
// unit-testable without a live API: parsing an issue reference out of user input
// and round-tripping the `owner/repo#number` external id the provider stores. The
// fetch itself lives in the worker's GitHubIssuesProvider, which reuses the
// workspace's installed GitHub App (so this source needs no credentials of its
// own — unlike Jira). GitHub issue bodies are already Markdown, so there is no
// body-conversion step here.

/**
 * What the connect UI renders. GitHub issues piggyback on the workspace's
 * existing GitHub App installation, so there are NO credential fields — the
 * connect form is just a confirmation, and `normalizeConnection` accepts an empty
 * bag.
 */
export const GITHUB_ISSUES_DESCRIPTOR: TaskSourceDescriptor = {
  source: 'github',
  label: 'GitHub Issues',
  icon: 'i-lucide-github',
  credentialFields: [],
  refLabel: 'Issue URL or owner/repo#number',
  refPlaceholder: 'octo/repo#123  or  https://github.com/octo/repo/issues/123',
  searchable: true,
}

/** The canonical `owner/repo#number` external id for an issue's parts. */
export function githubIssueExternalId(id: GitHubIssueExternalId): string {
  return `${id.owner}/${id.repo}#${id.number}`
}

// A GitHub owner/repo segment: letters, digits, '.', '_' and '-'. Deliberately
// permissive but bounded so a stray path can't masquerade as a ref.
const SEG = '[A-Za-z0-9._-]+'

/**
 * Resolve a GitHub issue reference from raw user input into the canonical
 * `owner/repo#number` external id. Accepts:
 *   - a full issue URL: `https://github.com/octo/repo/issues/123`
 *   - the `octo/repo/issues/123` path form
 *   - the shorthand `octo/repo#123`
 * Returns null when nothing parses. The owner/repo are kept verbatim (GitHub repo
 * names are case-preserving); only surrounding whitespace is trimmed.
 */
export function parseGitHubIssueRef(input: string): string | null {
  const trimmed = input.trim()
  const url = trimmed.match(new RegExp(`github\\.com/(${SEG})/(${SEG})/issues/(\\d+)`))
  if (url) return `${url[1]}/${url[2]}#${url[3]}`
  const path = trimmed.match(new RegExp(`^(${SEG})/(${SEG})/issues/(\\d+)$`))
  if (path) return `${path[1]}/${path[2]}#${path[3]}`
  const short = trimmed.match(new RegExp(`^(${SEG})/(${SEG})#(\\d+)$`))
  if (short) return `${short[1]}/${short[2]}#${short[3]}`
  return null
}

/** The parts of a GitHub issue external id (`owner/repo#number`). */
export interface GitHubIssueExternalId {
  owner: string
  repo: string
  number: number
}

/**
 * Split a stored `owner/repo#number` external id back into its parts. Returns
 * null if the id is malformed (defensive — ids are produced by
 * {@link parseGitHubIssueRef}, but a stale/hand-edited row should not throw).
 */
export function parseGitHubIssueExternalId(externalId: string): GitHubIssueExternalId | null {
  const m = externalId.match(new RegExp(`^(${SEG})/(${SEG})#(\\d+)$`))
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) }
}

/** The canonical web URL for an issue external id. */
export function githubIssueUrl(id: GitHubIssueExternalId): string {
  return `https://github.com/${id.owner}/${id.repo}/issues/${id.number}`
}

// Dependency-reference phrases recognised in a GitHub issue body. GitHub has no native
// "blocked by"/"depends on" field, so the convention is a line like `Blocked by #12` or
// `Depends on owner/repo#34`. We map each phrase to a normalized link direction.
const DEP_PHRASES: { re: RegExp; type: TaskDependencyLink['type'] }[] = [
  { re: /\bblocked\s+by\b/i, type: 'blockedBy' },
  { re: /\bdepends?\s+on\b/i, type: 'dependsOn' },
  { re: /\bblocks\b/i, type: 'blocks' },
]

/**
 * Parse dependency references out of a GitHub issue body. Scans line by line for the
 * recognised phrases ("blocked by", "depends on", "blocks"), each governing the issue
 * references that follow it — a bare `#123` (resolved against the issue's own repo) or a
 * cross-repo `owner/repo#123`. Each reference is attributed to the NEAREST phrase that
 * precedes it, so a mixed line like `Depends on #5 but blocks #9` classifies #5 and #9
 * independently. Returns normalized {@link TaskDependencyLink}s with canonical
 * `owner/repo#number` external ids. Lenient by design: anything it doesn't recognise is
 * simply skipped (GitHub bodies are free-form), and `relates` is never inferred here.
 */
export function parseIssueDependencyLinks(
  body: string,
  contextOwner: string,
  contextRepo: string,
): TaskDependencyLink[] {
  if (!body) return []
  const out: TaskDependencyLink[] = []
  const seen = new Set<string>()
  // Match `owner/repo#123` or a bare `#123`.
  const refRe = new RegExp(`(?:(${SEG})/(${SEG}))?#(\\d+)`, 'g')
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // Locate every recognised phrase on the line with its position, so each reference can be
    // attributed to the nearest phrase that precedes it (not just the first phrase on the line).
    const phraseHits: { index: number; type: TaskDependencyLink['type'] }[] = []
    for (const p of DEP_PHRASES) {
      const g = new RegExp(p.re.source, 'gi')
      let pm: RegExpExecArray | null
      while ((pm = g.exec(line)) !== null) {
        phraseHits.push({ index: pm.index, type: p.type })
        if (pm.index === g.lastIndex) g.lastIndex++ // never spin on a zero-width match
      }
    }
    if (!phraseHits.length) continue
    phraseHits.sort((a, b) => a.index - b.index)
    refRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = refRe.exec(line)) !== null) {
      // The governing phrase is the last one that starts before this reference.
      let governing: TaskDependencyLink['type'] | undefined
      for (const h of phraseHits) {
        if (h.index < m.index) governing = h.type
        else break
      }
      if (!governing) continue
      const owner = m[1] ?? contextOwner
      const repo = m[2] ?? contextRepo
      const externalId = githubIssueExternalId({ owner, repo, number: Number(m[3]) })
      const key = `${governing}:${externalId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ type: governing, externalId })
    }
  }
  return out
}

/**
 * Build the GitHub issue-search text for ONE repository. The scope is REQUIRED, and that
 * is a security property rather than an ergonomic one: `/search/issues` has no implicit
 * scope of its own, so a query carrying no `repo:` qualifier searches whatever the
 * credential can reach. Under a GitHub App installation token that happens to be the
 * installation's own repos, which is why an unscoped query looked harmless; under a PAT
 * (local mode, and any per-workspace PAT connection) the SAME query searches every public
 * repository on GitHub and hands the user strangers' issues. There is no caller for whom
 * an unscoped issue search is correct, so the type system refuses to build one.
 *
 * The adapter appends `is:issue`, so this returns the repo qualifier plus the user's text.
 * The slug is shape-validated exactly as {@link buildGitHubIntakeQuery}'s board is: `repo:`
 * is unquotable, so a value smuggling a second qualifier could otherwise widen the scope
 * this whole function exists to enforce.
 *
 * An EMPTY query yields the bare `repo:owner/name`, i.e. the scoped repo's issues rather
 * than nothing. That is unreachable over HTTP (the wire contract requires a non-empty query)
 * and it is the right answer for an internal caller: the scope is the floor of what this
 * search may return, never a filter that can be dropped.
 */
export function buildGitHubIssueSearchQuery(query: string, scope: TaskSearchRepoScope): string {
  const text = query.trim()
  const repoQualifier = `repo:${assertBoardSlug(`${scope.owner}/${scope.repo}`)}`
  return text ? `${repoQualifier} ${text}` : repoQualifier
}

/** Quote a user value for a GitHub search qualifier (`label:"needs triage"`); embedded quotes are dropped. */
function quoteQualifierValue(value: string): string {
  return `"${value.replace(/"/g, '').trim()}"`
}

/** The only shape a GitHub board scope may take: `owner/repo`, both plain path segments. */
const REPO_SLUG = new RegExp(`^${SEG}/${SEG}$`)

/**
 * Validate a board scope before it is interpolated into the search text.
 *
 * The `repo:` qualifier is the ONE hole in {@link buildGitHubIntakeQuery} that cannot be quoted
 * — GitHub's search grammar takes the slug bare — so it is validated instead. It has to be:
 * a board reaches this from a bug hunt's request body, where a value like
 * `owner/repo is:closed` would silently contradict the `is:open` / `no:assignee` qualifiers the
 * whole scan rests on, and one like `owner/repo org:elsewhere` would widen it. A malformed
 * scope is refused loudly rather than searched with a meaning nobody asked for; the recurring
 * intake's stored board goes through the same check, where a wrong-scope search is just as
 * wrong for being configured earlier.
 */
function assertBoardSlug(slug: string): string {
  if (!REPO_SLUG.test(slug)) {
    throw new ValidationError(`'${slug}' is not a GitHub repository scope; expected owner/repo.`, {
      reason: 'invalid_board' satisfies TaskSourceReadReason,
    })
  }
  return slug
}

/**
 * Build the GitHub search text for an issue-intake predicate search: open issues
 * in the configured repo matching every present predicate. Labels become
 * `label:"…"` qualifiers (each must be present), the issue type the org-level
 * `type:"…"` qualifier (repos without issue types simply match nothing for it —
 * the conventional fallback is labelling bugs, which the `labels` predicate
 * covers), and the title fragment `in:title` text. The adapter appends
 * `is:issue`; oldest-first ordering is NOT in-query — the caller passes the
 * search API's `created-asc` order (see `GitHubClient.searchIssues`). The
 * already-worked exclusion list is not expressible in GitHub search; the
 * provider filters it from a bounded overscan.
 *
 * Every value that reaches the search text is either quoted or, for the unquotable board
 * scope, shape-validated (see {@link assertBoardSlug}) — a caller-supplied string must never
 * be able to add a qualifier of its own.
 *
 * The board is REQUIRED for the same reason {@link buildGitHubIssueSearchQuery}'s scope is:
 * a boardless query searches everything the credential can see, which under a PAT is all of
 * public GitHub — and intake does not merely *display* its hit, it imports it and starts a
 * pipeline on it. A schedule stored without a repo is refused loudly (the fire reports the
 * failure) rather than quietly scanning the world.
 */
export function buildGitHubIntakeQuery(query: IssueIntakeQuery): string {
  const board = query.board.githubRepo?.trim()
  if (!board) {
    throw new ValidationError(
      'This GitHub issue search has no repository configured. Set the intake board to the ' +
        'owner/repo it should scan; an unscoped GitHub search reaches every public repository.',
      { reason: 'missing_board' satisfies TaskSourceReadReason },
    )
  }
  const parts: string[] = [`repo:${assertBoardSlug(board)}`]
  parts.push('is:open')
  // `no:assignee` is GitHub search's unassigned qualifier — pushed down like the rest, so a
  // hunt never spends its overscan window on issues somebody already owns.
  if (query.unassignedOnly) parts.push('no:assignee')
  if (query.issueType) parts.push(`type:${quoteQualifierValue(query.issueType)}`)
  for (const label of query.labels ?? []) parts.push(`label:${quoteQualifierValue(label)}`)
  // Quote the fragment as a literal phrase so a value that happens to contain a search
  // qualifier (e.g. `crash state:closed`) is matched as title text, not parsed as an
  // extra qualifier that would silently contradict `is:open` or widen the repo scope.
  if (query.titleFragment) parts.push(`in:title ${quoteQualifierValue(query.titleFragment)}`)
  return parts.join(' ')
}

/**
 * Resolve raw search input that names ONE specific issue in the SCOPED repo (rather than
 * free text) into its canonical `owner/repo#number` external id, so the caller can fetch it
 * and surface it as the exact match instead of a fuzzy search hit. Two forms:
 *   1. An explicit reference — a full issue URL, the `owner/repo/issues/n` path, or the
 *      `owner/repo#n` shorthand — accepted only when it names the SCOPED repo.
 *   2. A bare issue number (`11`) — resolved against `scope` (the service's repo), which is
 *      the only way to know which repo a lone number belongs to.
 * Returns null when the input is neither (treat it as free-text search).
 *
 * A reference naming a DIFFERENT repository resolves to null on purpose: search results are
 * the service's own repo and nothing else, so a stray paste can never make another repo's
 * issue look like a hit the search found. Linking that issue is still supported — it is an
 * explicit reference, handled by the picker's "attach by reference" row, which imports the
 * ref directly and never rides this search path.
 *
 * Repo comparison is case-insensitive: GitHub owner/repo names are case-PRESERVING but
 * case-INSENSITIVE for lookup, so `Owner/Repo#1` and `owner/repo#1` are the same issue and
 * matching them exactly would reject a paste from the browser address bar.
 *
 * The id is then rebuilt from the SCOPE rather than echoed back in the casing the user typed.
 * An external id is stored verbatim (`fetchTask` passes it straight through to the
 * projection), so returning `Owner/Repo#1` here would persist a SECOND row for an issue the
 * search already knows as `owner/repo#1` — two context keys, two "imported" entries, one
 * issue. The scope's casing comes from the repo projection, i.e. GitHub's own, so it is the
 * canonical form. (`walkIntakeHits` lowercases both sides of its exclusion check for exactly
 * this hazard; here the canonical form is known, so it can be normalised instead.)
 */
export function detectExactGitHubIssueRef(
  query: string,
  scope: TaskSearchRepoScope,
): string | null {
  const trimmed = query.trim()
  const ref = parseGitHubIssueRef(trimmed)
  if (ref) {
    const id = parseGitHubIssueExternalId(ref)
    if (!id || !isScopedRepo(id, scope)) return null
    return githubIssueExternalId({ owner: scope.owner, repo: scope.repo, number: id.number })
  }
  if (/^\d+$/.test(trimmed)) {
    return githubIssueExternalId({ owner: scope.owner, repo: scope.repo, number: Number(trimmed) })
  }
  return null
}

/** Whether a parsed issue id names the scoped repository (case-insensitively, as GitHub does). */
function isScopedRepo(id: GitHubIssueExternalId, scope: TaskSearchRepoScope): boolean {
  return (
    id.owner.toLowerCase() === scope.owner.toLowerCase() &&
    id.repo.toLowerCase() === scope.repo.toLowerCase()
  )
}

/**
 * The provider's `TaskRepoScopeRules` matcher: whether a STORED external id belongs to the
 * scoped repository. Case-insensitive, because GitHub owner/repo names are, and the two sides
 * come from different places (the id was minted from user input, the scope from the repo
 * projection), so the casing is routinely not the same for one repository.
 *
 * An id that does not parse is out of scope: the row is stale or hand-edited, and a repository it
 * cannot name is not this one.
 */
export function githubIssueInRepoScope(externalId: string, scope: TaskSearchRepoScope): boolean {
  const id = parseGitHubIssueExternalId(externalId)
  return id ? isScopedRepo(id, scope) : false
}

/**
 * Project a search hit onto a {@link BugCandidate}. GitHub's `/search/issues` response carries
 * the whole issue payload, so every field here comes from the SAME call the hunt already
 * makes — see the optional fields on {@link GitHubIssueSearchHit} for why they may be absent
 * (an adapter projecting another backend onto the GitHub shape).
 *
 * The shape itself is the one every repo-backed source shares; what GitHub supplies is its own
 * external-id grammar. See {@link repoIssueBugCandidateMapper} for why `priority`/`type` stay empty.
 */
export const githubHitToBugCandidate = repoIssueBugCandidateMapper('github', githubIssueExternalId)

/**
 * Map an installation's repositories onto hunt boards: the shared repo-backed projection, since a
 * GitHub board scope is the `owner/repo` slug {@link buildGitHubIntakeQuery} puts in `repo:`.
 */
export const githubReposToBoards = repoRefsToBoards
