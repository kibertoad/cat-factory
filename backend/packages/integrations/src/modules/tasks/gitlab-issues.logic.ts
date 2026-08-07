import type {
  ProjectIssueQuery,
  TaskSearchRepoScope,
  TaskSourceDescriptor,
} from '@cat-factory/kernel'

// GitLab-issues task-source pure logic, the sibling of `github-issues.logic.ts`: the
// descriptor, the external-id grammar and its round-trip, the ref parser, and the
// project-scoped search query. Pure, so every rule below is unit-testable without a
// live API; the fetch itself lives in `GitLabIssuesProvider`.
//
// The one structural difference from the GitHub logic drives most of this file: a GitLab
// project path NESTS. `group/sub/project` is a legal project, and the client folds it into
// `{ owner: 'group/sub', repo: 'project' }` (splitting at the LAST slash, the same way
// GitLab's own web URLs read), so an owner here is a multi-segment path where GitHub's is
// a single account name. Reusing the GitHub grammar would not merely be inconvenient: a
// subgroup issue would round-trip through it as garbage rather than as a refusal.
//
// GitLab issue descriptions are already Markdown, so there is no body-conversion step.

/**
 * What the connect UI renders. GitLab issues ride the workspace's existing VCS connection
 * (the `provider: 'gitlab'` row a PAT connect writes), so there are NO credential fields —
 * the same credentialless shape GitHub Issues has, keyed on a different connection.
 */
export const GITLAB_ISSUES_DESCRIPTOR: TaskSourceDescriptor = {
  source: 'gitlab',
  label: 'GitLab Issues',
  icon: 'i-lucide-gitlab',
  credentialFields: [],
  refLabel: 'Issue URL or group/project#number',
  refPlaceholder: 'acme/web#123  or  https://gitlab.com/acme/web/-/issues/123',
  searchable: true,
}

/** The parts of a GitLab issue external id (`group/sub/project#iid`). */
export interface GitLabIssueExternalId {
  /** The project's namespace path, which may itself nest (`group/sub`). */
  owner: string
  /** The project's own path segment. */
  repo: string
  /**
   * The project-relative issue number (`iid`), which is what a human sees and what
   * `/projects/:id/issues/:iid` takes. NEVER GitLab's global `id`, despite that being the
   * field literally named `id` on the payload.
   */
  number: number
}

/** The canonical `group/sub/project#iid` external id for an issue's parts. */
export function gitlabIssueExternalId(id: GitLabIssueExternalId): string {
  return `${id.owner}/${id.repo}#${id.number}`
}

// A single path segment of a GitLab project path: letters, digits, '.', '_' and '-'.
const SEG = '[A-Za-z0-9._-]+'
// A full project path: at least two segments (a namespace and the project), and possibly
// more, because GitLab nests subgroups. Non-greedy up to the LAST slash so the split below
// matches how the client folds a web URL.
const PROJECT_PATH = `${SEG}(?:/${SEG})+`

/**
 * Split a project path at its LAST slash, which is the same fold the GitLab client applies
 * to a `web_url`: everything before is the namespace (`group/sub`), the final segment is the
 * project. Returns null for a path with no slash, i.e. one that names no project.
 */
function splitProjectPath(path: string): { owner: string; repo: string } | null {
  const idx = path.lastIndexOf('/')
  if (idx <= 0 || idx === path.length - 1) return null
  return { owner: path.slice(0, idx), repo: path.slice(idx + 1) }
}

/**
 * Resolve a GitLab issue reference from raw user input into the canonical
 * `group/sub/project#iid` external id. Accepts:
 *   - a full issue URL: `https://gitlab.example.com/acme/sub/web/-/issues/123`
 *   - the `acme/sub/web/-/issues/123` path form
 *   - the shorthand `acme/sub/web#123`
 * Returns null when nothing parses. Path segments are kept verbatim (a GitLab path is
 * case-sensitive in a way GitHub's is not); only surrounding whitespace is trimmed.
 *
 * The URL form matches the `/-/issues/` separator GitLab puts between a project path and a
 * resource, which is also what makes an arbitrarily deep project path unambiguous: without
 * it there would be no way to tell where the path ends and `issues/123` begins.
 */
export function parseGitLabIssueRef(input: string): string | null {
  const trimmed = input.trim()
  const url = trimmed.match(new RegExp(`^https?://[^/]+/(${PROJECT_PATH})/-/issues/(\\d+)`))
  if (url) return `${url[1]}#${url[2]}`
  const path = trimmed.match(new RegExp(`^(${PROJECT_PATH})/-/issues/(\\d+)$`))
  if (path) return `${path[1]}#${path[2]}`
  const short = trimmed.match(new RegExp(`^(${PROJECT_PATH})#(\\d+)$`))
  if (short) return `${short[1]}#${short[2]}`
  return null
}

/**
 * Split a stored `group/sub/project#iid` external id back into its parts. Returns null if
 * the id is malformed (defensive — ids are produced by {@link parseGitLabIssueRef}, but a
 * stale or hand-edited row should not throw).
 */
export function parseGitLabIssueExternalId(externalId: string): GitLabIssueExternalId | null {
  const m = externalId.match(new RegExp(`^(${PROJECT_PATH})#(\\d+)$`))
  if (!m) return null
  const parts = splitProjectPath(m[1]!)
  if (!parts) return null
  return { owner: parts.owner, repo: parts.repo, number: Number(m[2]) }
}

/**
 * Build an issue's web URL from the deployment's GitLab web base, for the one case where the
 * API answered without a `web_url` of its own.
 *
 * There is deliberately no constant fallback: a self-managed GitLab lives at the
 * deployment's own host, so `gitlab.com` would not be a guess that is usually right, it
 * would be a link to a stranger's instance. `undefined` in, `''` out — an empty URL renders
 * as no link, where a wrong one renders as a link to the wrong issue.
 */
export function gitlabIssueUrl(id: GitLabIssueExternalId, webBaseUrl: string | undefined): string {
  const base = webBaseUrl?.replace(/\/+$/, '')
  if (!base) return ''
  return `${base}/${id.owner}/${id.repo}/-/issues/${id.number}`
}

/**
 * Derive the GitLab WEB base from the configured API base, which is the same host with the
 * REST prefix on the end (`https://gitlab.example.com/api/v4`). Returns undefined for an
 * absent/unparseable value rather than a guess, so {@link gitlabIssueUrl} withholds its link.
 */
export function gitlabWebBaseFromApiBase(apiBase: string | undefined): string | undefined {
  const trimmed = apiBase?.trim().replace(/\/+$/, '')
  if (!trimmed) return undefined
  const stripped = trimmed.replace(/\/api\/v\d+$/, '')
  return stripped || undefined
}

/**
 * Build the project-scoped issue search for the picker's free-text box. The scope is the
 * repository the searching service frame is linked to, and it is an ARGUMENT of the request
 * rather than text in the query, so there is no unscoped spelling of this search to reach by
 * accident — see the kernel port's note on why GitLab in particular cannot express the scope
 * as a qualifier.
 *
 * Both states are searched, not just open ones: a picker attaches an issue for CONTEXT, and
 * a closed issue is routinely the one a follow-up task points at. (The intake/hunt reads,
 * which pick work to START, are the ones that set `openOnly`.)
 */
export function buildGitLabIssueSearchQuery(query: string, limit: number): ProjectIssueQuery {
  const text = query.trim()
  return { limit, ...(text ? { text } : {}) }
}

/**
 * Resolve raw search input that names ONE specific issue in the SCOPED project (rather than
 * free text) into its canonical external id, so the caller can fetch it and offer it as the
 * exact match. Two forms, mirroring the GitHub logic's:
 *   1. An explicit reference (issue URL, `/-/issues/` path, or `group/project#n` shorthand),
 *      accepted only when it names the SCOPED project.
 *   2. A bare issue number, resolved against `scope` — the only way to know which project a
 *      lone number belongs to.
 * Returns null when the input is neither (treat it as free-text search).
 *
 * A reference naming a DIFFERENT project resolves to null on purpose: a search returns the
 * service's own project and nothing else, so a stray paste can never be dressed up as a hit
 * the search found. Linking that issue is still supported through the picker's explicit
 * attach-by-reference row, which imports the ref directly.
 *
 * Unlike the GitHub twin the comparison is case-SENSITIVE, and the id is echoed from the
 * scope for the same reason that one is: GitLab project paths are lowercase by construction
 * but their display forms are not, and an external id is stored verbatim, so normalising
 * here is what stops one issue becoming two rows.
 */
export function detectExactGitLabIssueRef(
  query: string,
  scope: TaskSearchRepoScope,
): string | null {
  const trimmed = query.trim()
  const ref = parseGitLabIssueRef(trimmed)
  if (ref) {
    const id = parseGitLabIssueExternalId(ref)
    if (!id || id.owner !== scope.owner || id.repo !== scope.repo) return null
    return gitlabIssueExternalId({ owner: scope.owner, repo: scope.repo, number: id.number })
  }
  if (/^\d+$/.test(trimmed)) {
    return gitlabIssueExternalId({
      owner: scope.owner,
      repo: scope.repo,
      number: Number(trimmed),
    })
  }
  return null
}
