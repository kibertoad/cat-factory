import type { DocumentSourceDescriptor } from '@cat-factory/kernel'

// GitHub repo-doc document-source pure logic, kept out of the worker so it is
// unit-testable without a live API: parsing a file reference out of user input
// and round-tripping the `owner/repo:path` external id the provider stores. Like
// the GitHub-issues task source, the provider reuses the workspace's installed
// GitHub App, so this source needs no credentials of its own. A repo doc is a
// single Markdown/text file (a README, an RFC under `docs/`, an architecture
// note) linked to a task as context; the file body is already Markdown-ish, so
// there is no body-conversion step here.

/**
 * What the connect UI renders. GitHub docs piggyback on the workspace's existing
 * GitHub App installation, so there are NO credential fields — the connect form
 * is just a confirmation, and `normalizeConnection` accepts an empty bag.
 */
export const GITHUB_DOCS_DESCRIPTOR: DocumentSourceDescriptor = {
  source: 'github',
  label: 'GitHub Docs',
  icon: 'i-lucide-file-code-2',
  credentialFields: [],
  refLabel: 'File URL or owner/repo:path',
  refPlaceholder:
    'octo/repo:docs/architecture.md  or  https://github.com/octo/repo/blob/main/README.md',
  searchable: true,
}

// An owner/repo segment: letters, digits, '.', '_' and '-'. Mirrors the GitHub
// issues source's segment grammar.
const SEG = '[A-Za-z0-9._-]+'

/** The parts of a GitHub doc external id (`owner/repo:path`). */
export interface GitHubDocExternalId {
  owner: string
  repo: string
  /** Path relative to the repo root, e.g. `docs/architecture.md`. */
  path: string
}

/** Build the canonical `owner/repo:path` external id from its parts. */
export function githubDocExternalId(id: GitHubDocExternalId): string {
  return `${id.owner}/${id.repo}:${id.path}`
}

/**
 * Resolve a GitHub repo-doc reference from raw user input into the canonical
 * `owner/repo:path` external id. Accepts:
 *   - a blob URL: `https://github.com/octo/repo/blob/main/docs/x.md`
 *   - a raw URL: `https://raw.githubusercontent.com/octo/repo/main/docs/x.md`
 *   - the shorthand `octo/repo:docs/x.md`
 * The branch/ref in a URL is dropped — the provider reads the default branch — so
 * the external id (and thus a re-import's identity) is branch-stable. Returns
 * null when nothing parses. Owner/repo/path are kept verbatim (case-preserving).
 */
export function parseGitHubDocRef(input: string): string | null {
  const trimmed = input.trim()
  const blob = trimmed.match(new RegExp(`github\\.com/(${SEG})/(${SEG})/blob/[^/]+/(.+)$`))
  if (blob) return `${blob[1]}/${blob[2]}:${stripQuery(blob[3]!)}`
  const raw = trimmed.match(
    new RegExp(`raw\\.githubusercontent\\.com/(${SEG})/(${SEG})/[^/]+/(.+)$`),
  )
  if (raw) return `${raw[1]}/${raw[2]}:${stripQuery(raw[3]!)}`
  const short = trimmed.match(new RegExp(`^(${SEG})/(${SEG}):(.+)$`))
  if (short) return `${short[1]}/${short[2]}:${short[3]!.replace(/^\/+/, '')}`
  return null
}

/** Drop any `?query`/`#hash` and leading slashes from a URL path tail. */
function stripQuery(path: string): string {
  return path.split(/[?#]/)[0]!.replace(/^\/+/, '')
}

/**
 * Split a stored `owner/repo:path` external id back into its parts. Returns null
 * if the id is malformed (defensive — ids are produced by
 * {@link parseGitHubDocRef}, but a stale/hand-edited row should not throw).
 */
export function parseGitHubDocExternalId(externalId: string): GitHubDocExternalId | null {
  const m = externalId.match(new RegExp(`^(${SEG})/(${SEG}):(.+)$`))
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, path: m[3]! }
}

/** The canonical web URL for a doc external id (default branch via `HEAD`). */
export function githubDocUrl(id: GitHubDocExternalId): string {
  return `https://github.com/${id.owner}/${id.repo}/blob/HEAD/${id.path}`
}

/** A human title for a doc: its file base name (e.g. `architecture.md`). */
export function githubDocTitle(path: string): string {
  const base = path.split('/').filter(Boolean).pop()
  return base && base.length > 0 ? base : path
}

/**
 * Build a GitHub code-search query scoped to one account. GitHub's code-search
 * API rejects unscoped queries, so we append an `org:`/`user:` qualifier chosen
 * from the installation's target type. The free text is trimmed and the account
 * login is taken verbatim (GitHub logins have no special search chars).
 */
export function buildGitHubCodeSearchQuery(
  query: string,
  account: string,
  targetType: 'Organization' | 'User',
): string {
  const qualifier = targetType === 'Organization' ? 'org' : 'user'
  return `${query.trim()} ${qualifier}:${account}`
}
