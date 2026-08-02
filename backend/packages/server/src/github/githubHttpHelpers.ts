// Pure response/header parsing helpers for FetchGitHubClient. Split out of the client
// file to keep it under its size budget: these are class-independent utilities (URL/
// base64/timestamp/`Link`-header parsing) shared by the REST methods, with no coupling
// to the client's dependencies or `this`, so they live cleanly on their own.

/** Derive `{owner, repo, number}` from an issue's `html_url`, or null if it doesn't match. */
export function parseIssueHtmlUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) }
}

/** Decode the contents API's base64 (whitespace-laden) payload to a UTF-8 string. */
export function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** Parse a GitHub ISO-8601 timestamp to epoch ms, or 0 when absent/unparseable. */
export function parseGitHubTime(value: string | null | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/** A finite numeric response header, or null when absent/unparseable. */
export function numHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** The absolute URL of the `rel="next"` entry in a `Link` header, if present. */
export function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}

/**
 * The page number from a `Link` header's `rel="last"` entry (GitHub advertises it alongside
 * `next` for offset-paginated collections like `/user/repos`), so a caller can fetch the
 * remaining pages CONCURRENTLY instead of walking `next` one blocking request at a time.
 * Undefined when the header omits `last` (single page, or a cursor-paginated endpoint).
 */
export function parseLastPage(link: string | null): number | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="last"/)
    if (!match) continue
    try {
      const page = Number(new URL(match[1]!).searchParams.get('page'))
      return Number.isFinite(page) && page > 0 ? page : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

// Request constants shared by every GitHub caller here — the installation-authenticated client
// and the viewer-token reads alike. They live with the helpers because both modules must send
// the SAME headers and honour the same page cap; a second copy is a second thing to keep in step.
export const USER_AGENT = 'cat-factory'
export const API_VERSION = '2022-11-28'
export const ACCEPT = 'application/vnd.github+json'
export const PER_PAGE = 100
export const MAX_PAGES = 10

/**
 * Carries the HTTP status so callers/queue can decide whether to retry.
 *
 * Lives with the shared HTTP helpers rather than on the client that throws it, because several
 * modules now classify off it (`reconcileStaleRepos`, the branch-protection probe) and the
 * client is at its size budget. `FetchGitHubClient` re-exports it, so existing importers are
 * unaffected and `instanceof` stays authoritative — there is exactly one class.
 */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Whether the response was rate-limited (`x-ratelimit-remaining: 0`). GitHub reports a
     * PRIMARY rate-limit exhaustion as a 403 (only secondary limits are 429), so status alone
     * cannot tell a rate-limit apart from a permission denial — a consumer reads this flag to
     * classify the two differently. Retained here so the signal is available structurally
     * instead of only baked into the human message.
     */
    readonly rateLimited = false,
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

/** The HTTP status of a GitHub API failure, or undefined for any other error shape. */
export function githubApiStatus(error: unknown): number | undefined {
  return error instanceof GitHubApiError ? error.status : undefined
}
