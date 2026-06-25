import type {
  TaskDependencyLink,
  TaskSearchRepoScope,
  TaskSourceDescriptor,
} from '@cat-factory/kernel'

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
 * Parse dependency references out of a GitHub issue body. Scans line by line for a
 * recognised phrase ("blocked by", "depends on", "blocks") followed by one or more issue
 * references — a bare `#123` (resolved against the issue's own repo) or a cross-repo
 * `owner/repo#123`. Returns normalized {@link TaskDependencyLink}s with canonical
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
    const phrase = DEP_PHRASES.find((p) => p.re.test(line))
    if (!phrase) continue
    refRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = refRe.exec(line)) !== null) {
      const owner = m[1] ?? contextOwner
      const repo = m[2] ?? contextRepo
      const externalId = githubIssueExternalId({ owner, repo, number: Number(m[3]) })
      const key = `${phrase.type}:${externalId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ type: phrase.type, externalId })
    }
  }
  return out
}

/**
 * Build the GitHub issue-search text, scoping it to a single repo when a service's
 * repo is known. The `repo:owner/name` qualifier keeps hits from leaking in from
 * sibling repositories the installation can also see; the adapter appends
 * `is:issue`, so this returns only the user's text plus the optional scope.
 */
export function buildGitHubIssueSearchQuery(query: string, scope?: TaskSearchRepoScope): string {
  const text = query.trim()
  if (!scope) return text
  const repoQualifier = `repo:${scope.owner}/${scope.repo}`
  return text ? `${repoQualifier} ${text}` : repoQualifier
}

/**
 * Resolve raw search input that names ONE specific issue (rather than free text)
 * into its canonical `owner/repo#number` external id, so the caller can fetch it
 * and surface it as the exact match instead of a fuzzy search hit. Two forms:
 *   1. An explicit reference — a full issue URL, the `owner/repo/issues/n` path, or
 *      the `owner/repo#n` shorthand — parsed verbatim (its own repo wins, even if
 *      it differs from `scope`, so a pasted URL points at the actual issue).
 *   2. A bare issue number (`11`) — resolved against `scope` (the service's repo),
 *      which is the only way to know which repo a lone number belongs to.
 * Returns null when the input is neither (treat it as free-text search).
 */
export function detectExactGitHubIssueRef(
  query: string,
  scope?: TaskSearchRepoScope,
): string | null {
  const trimmed = query.trim()
  const ref = parseGitHubIssueRef(trimmed)
  if (ref) return ref
  if (scope && /^\d+$/.test(trimmed)) {
    return githubIssueExternalId({ owner: scope.owner, repo: scope.repo, number: Number(trimmed) })
  }
  return null
}
