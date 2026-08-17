// Pure response/header parsing helpers for FetchGitHubClient. Split out of the client
// file to keep it under its size budget: these are class-independent utilities (URL/
// base64/timestamp/`Link`-header parsing) shared by the REST methods, with no coupling
// to the client's dependencies or `this`, so they live cleanly on their own.

import { VcsApiError } from '@cat-factory/kernel'

/** Derive `{owner, repo, number}` from an issue's `html_url`, or null if it doesn't match. */
export function parseIssueHtmlUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) }
}

/**
 * Decode the contents API's base64 (whitespace-laden) payload, SAYING when the bytes were not text.
 *
 * Strict first, so `lossy` is the decoder's own verdict rather than a scan for a character a text file
 * may legitimately contain: a document that genuinely holds a U+FFFD is not a binary file, and a check
 * on the output could not tell the two apart. The lossy rendering is still ANSWERED, because what to
 * do about it belongs to the caller: a pre-op folding a file into a prompt wants the best available
 * text, and a read whose job is byte-exact grading refuses (see `RepoFileContent.lossy`).
 *
 * `FetchGitLabClient` holds the same function, because there is no home below both: kernel names no
 * web globals by design (its `lib` is ES2022 alone, where both clients add DOM for `atob` and
 * `TextDecoder`), and neither client package can see the other. Change one, change the other.
 */
export function decodeRepoFileBase64(value: string): { content: string; lossy: boolean } {
  const binary = atob(value.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), lossy: false }
  } catch {
    // Not a swallow: the throw IS the answer, reported as `lossy` rather than lost. The strict
    // decoder's own error names only the offending byte, which tells a caller nothing more.
    return { content: new TextDecoder().decode(bytes), lossy: true }
  }
}

/**
 * Bytes the contents API will serve in one read, past which it refuses.
 *
 * GitHub's own documented ceiling for `GET /repos/{o}/{r}/contents/{path}`: 1 MB with the JSON media
 * type. Named here (rather than at the one comparison) because it is the number a refusal reports to
 * a caller, and a caller that knows it can pick a different mechanism instead of retrying.
 */
export const GITHUB_CONTENTS_MAX_BYTES = 1_048_576

/**
 * Whether a failed contents read was refused for the blob's SIZE rather than for the credential.
 *
 * GitHub answers an over-limit blob with a `403` carrying `"code": "too_large"`, the same status as
 * a permission denial and as an exhausted primary rate limit, so nothing structural separates them:
 * the body is the only signal, which is why {@link GitHubApiError} carries it. Matched on the human
 * sentence as well as the code because the two sit at opposite ends of a body that arrives truncated
 * and the sentence comes first. Not matched against the whole `message`, which by then also carries
 * this repository's own 403 remedy prose about missing scopes.
 */
export function isGitHubBlobTooLarge(error: unknown): boolean {
  if (!(error instanceof GitHubApiError) || error.status !== 403) return false
  return /too_large|too large/i.test(error.body ?? '')
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
 * unaffected and `instanceof` stays authoritative: there is exactly one class.
 *
 * A subclass of kernel's `VcsApiError`, which is what a consumer above the adapters branches on: a
 * caller asking "did the provider refuse this" must get the same answer on a GitLab deployment, and
 * only the base class can give it one. Checking this class stays right for anything asking about
 * the GitHub API specifically.
 */
export class GitHubApiError extends VcsApiError {
  constructor(
    status: number,
    message: string,
    /**
     * Whether the response was rate-limited (`x-ratelimit-remaining: 0`). GitHub reports a
     * PRIMARY rate-limit exhaustion as a 403 (only secondary limits are 429), so status alone
     * cannot tell a rate-limit apart from a permission denial — a consumer reads this flag to
     * classify the two differently. Retained here so the signal is available structurally
     * instead of only baked into the human message.
     */
    rateLimited = false,
    /**
     * The response body (as the caller truncated it), retained STRUCTURALLY rather than only baked
     * into `message`.
     *
     * Because one status covers causes that need different answers and the body is the only thing
     * that separates them: an over-limit blob and a missing scope are both a `403`
     * (see {@link isGitHubBlobTooLarge}). Reading it back out of the rendered `message` would mean
     * matching against this repository's own remedy prose, which is appended to the same string and
     * changes for reasons that have nothing to do with what GitHub said.
     */
    readonly body?: string,
  ) {
    super('github', status, message, rateLimited)
    this.name = 'GitHubApiError'
  }
}

/** The HTTP status of a GitHub API failure, or undefined for any other error shape. */
export function githubApiStatus(error: unknown): number | undefined {
  return error instanceof GitHubApiError ? error.status : undefined
}

/** One fetched page of a `Link`-paginated GitHub listing, as the client's request helper returns it. */
export interface PaginatedPage {
  status: number
  json: unknown
  /** Absolute URL of the next page, if any. */
  next?: string
}

/**
 * Walk a `Link`-paginated listing to the page cap, reporting whether it stopped with more to fetch.
 *
 * A free function over a `fetchPage` callback rather than a client method, for the reason every
 * other helper here is: the walk needs nothing from the client but the ability to make one request,
 * so keeping it beside `MAX_PAGES` (the cap it enforces) puts the loop and its bound in one place
 * and leaves the client file to the REST methods.
 *
 * `truncated` is the fact a PUBLISHING caller owes its reader: a repository missing because the
 * enumeration stopped and one the credential cannot reach are opposite answers, and by the time the
 * items are a bare array the difference is gone. A walk that ended on the caller's own `stop`
 * predicate, or on a `304 Not Modified`, is NOT truncated: it found what it came for.
 */
export async function walkPages<T>(
  start: string,
  fetchPage: (url: string) => Promise<PaginatedPage>,
  map: (json: unknown) => T[],
  stop?: (page: T[]) => boolean,
): Promise<{ items: T[]; truncated: boolean }> {
  const all: T[] = []
  let url: string | undefined = start
  let stopped = false
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response = await fetchPage(url)
    if (response.status === 304) {
      stopped = true
      break
    }
    const mapped = map(response.json)
    all.push(...mapped)
    if (stop?.(mapped)) {
      stopped = true
      break
    }
    url = response.next
  }
  return { items: all, truncated: !stopped && url !== undefined }
}
