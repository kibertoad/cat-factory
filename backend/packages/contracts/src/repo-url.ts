// Parsing a pasted VCS repository web URL down to its parts — shared by the SPA (the
// fragment library's paste-a-directory import, which needs the repo slug + path client-side)
// and the backend (the available-repos picker search, which must resolve a pasted URL
// DIRECTLY instead of feeding it to the provider's name search, where a URL matches
// nothing). Pure string logic, no wire schema — it lives in contracts because this is the
// only package both sides import.

/** The parts recovered from a repository web URL. */
export interface ParsedRepoWebUrl {
  /**
   * The repo's namespace. For a GitLab URL with subgroups this is the WHOLE group path
   * (`group/subgroup`), which the `/-/` separator makes unambiguous; a GitHub-shaped URL
   * always yields a single segment.
   */
  owner: string
  /** The repository name (a trailing `.git` is stripped). */
  repo: string
  /**
   * The git ref segment of a `/tree/<ref>/…` / `/blob/<ref>/…` URL, when present.
   * KNOWN LIMITATION (same as `parseGitHubDocRef`): a ref containing `/` cannot be
   * recovered from the URL alone — the first segment is assumed to be the whole ref.
   */
  ref?: string
  /** Repo-root-relative path (`''` for a bare repo URL). Query/hash are stripped. */
  path: string
  /** `file` for a blob/raw URL, `dir` for a tree or bare repo URL. */
  kind: 'file' | 'dir'
}

// One owner/repo path segment (mirrors the GitHub docs source's segment grammar).
const SEG = /^[A-Za-z0-9._-]+$/

/** The GitHub/GitLab web-UI markers that separate the repo slug from a ref + path. */
const TREE_MARKERS = new Set(['tree', 'blob', 'raw'])

// Split a pasted URL into host + path WITHOUT the `URL` global (this package builds
// against a minimal lib — no DOM). A scheme-less paste (`github.com/owner/repo/…`) is
// accepted when its first segment looks like a hostname, so the parse doesn't hinge on
// the scheme; a plain `owner/repo` slug deliberately does NOT parse (no dotted host).
function splitUrl(input: string): { host: string; path: string } | null {
  const trimmed = input.trim()
  if (trimmed.includes(' ')) return null
  const schemeless = trimmed.replace(/^https?:\/\//i, '')
  const slash = schemeless.indexOf('/')
  if (slash <= 0) return null
  const host = schemeless.slice(0, slash).replace(/:\d+$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null
  const path = schemeless.slice(slash + 1).split(/[?#]/)[0] ?? ''
  return { host: host.toLowerCase(), path }
}

/**
 * Parse a repository web URL (GitHub-shaped `owner/repo[/tree|blob|raw/<ref>/<path>]`, the
 * GitLab `namespace/project/-/tree|blob/<ref>/<path>` form, or a
 * `raw.githubusercontent.com/owner/repo/<ref>/<path>` raw URL) into its parts. Host-agnostic
 * apart from the raw-content special case: self-managed instances live on their own domains,
 * and which provider a repo belongs to is the deployment's concern, not the URL's. Returns
 * null when the input is not a URL or does not name at least `owner/repo`.
 */
export function parseRepoWebUrl(input: string): ParsedRepoWebUrl | null {
  const url = splitUrl(input)
  if (!url) return null
  const segments = url.path
    .split('/')
    .filter(Boolean)
    .map((s: string) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  if (segments.length < 2) return null

  // GitLab: everything before the literal `-` segment is `namespace…/project`.
  const dash = segments.indexOf('-')
  if (dash >= 2) {
    const slug = segments.slice(0, dash)
    const repo = stripGitSuffix(slug[slug.length - 1]!)
    const owner = slug.slice(0, -1).join('/')
    if (!repo || !SEG.test(repo) || slug.slice(0, -1).some((s) => !SEG.test(s))) return null
    return withMarker(owner, repo, segments.slice(dash + 1))
  }

  const owner = segments[0]!
  const repo = stripGitSuffix(segments[1]!)
  if (!SEG.test(owner) || !repo || !SEG.test(repo)) return null

  // raw.githubusercontent.com has no marker segment: `/owner/repo/<ref>/<path>`.
  if (/(^|\.)raw\.githubusercontent\.com$/i.test(url.host)) {
    const [ref, ...path] = segments.slice(2)
    if (!ref || path.length === 0) return null
    return { owner, repo, ref, path: path.join('/'), kind: 'file' }
  }

  return withMarker(owner, repo, segments.slice(2))
}

/** Interpret the segments after the repo slug (`[]`, or `tree|blob|raw / <ref> / <path…>`). */
function withMarker(owner: string, repo: string, rest: string[]): ParsedRepoWebUrl | null {
  if (rest.length === 0) return { owner, repo, path: '', kind: 'dir' }
  const [marker, ref, ...path] = rest
  if (!marker || !TREE_MARKERS.has(marker) || !ref) return null
  return {
    owner,
    repo,
    ref,
    path: path.join('/'),
    kind: marker === 'tree' ? 'dir' : 'file',
  }
}

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, '')
}

/**
 * Normalize a repo-picker search query so a pasted repository URL never depends on the
 * provider's name search: a URL collapses to its `owner/repo` slug (which the picker's
 * direct point-read and substring matches both understand); anything else passes through
 * unchanged.
 */
export function normalizeRepoSearchQuery(query: string): string {
  const parsed = parseRepoWebUrl(query)
  return parsed ? `${parsed.owner}/${parsed.repo}` : query
}

/**
 * Split an exact `owner/name` slug (no URL, no path). The backend uses this to decide
 * whether a picker query can ALSO be resolved by a direct repo point-read alongside the
 * provider search. Returns null for anything that is not exactly two valid segments.
 */
export function parseOwnerRepoSlug(query: string): { owner: string; repo: string } | null {
  const m = query.trim().split('/')
  if (m.length !== 2) return null
  const [owner, repo] = m as [string, string]
  if (!SEG.test(owner) || !SEG.test(repo)) return null
  return { owner, repo }
}
