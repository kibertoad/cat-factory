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
