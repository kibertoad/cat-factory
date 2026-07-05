import { environmentsLogic, readCappedText, safeFetch } from '@cat-factory/integrations'
import type { WebSearchResponse, WebSearchUpstream } from '../../runtime/gateways.js'

// SearXNG is reached at an account-configured URL, so — unlike the hardcoded Brave
// endpoint — it MUST be SSRF-guarded: block private/internal/metadata hosts (the SSRF
// target) while still allowing a public self-hosted instance over http or https. The
// same policy guards the write boundary (AccountSettingsService), so a bad URL is
// rejected when saved AND re-checked (with per-hop redirect revalidation) when fetched.
export const WEB_SEARCH_URL_SAFETY_POLICY = { schemes: ['http', 'https'], allowHosts: [] } as const

/** Assert an account-supplied web-search URL is not an SSRF vector. Throws on a bad host. */
export function assertSafeWebSearchUrl(url: string): void {
  environmentsLogic.assertSafeEnvironmentUrl(url, 'SearXNG URL', WEB_SEARCH_URL_SAFETY_POLICY)
}

/** Redirect/size failures from the shared SSRF-safe fetch surface as a plain search error. */
const makeSearchError = (status: number, message: string) =>
  new Error(`Web search ${message.toLowerCase()} (HTTP ${status})`)

/** Hard cap on the bytes read off a search response body. */
const MAX_SEARCH_RESPONSE_BYTES = 2_000_000

// Runtime-neutral web-search upstreams for the container search proxy. Each performs
// the actual search server-side (under the deployment's own provider key) and maps the
// provider's payload into the normalised SearXNG-style shape the proxy returns. They
// use only `fetch`, so the SAME implementation serves both facades — the vendor key
// lives on the backend, never in the sandbox (mirroring the LLM-proxy posture).

/** Default number of results requested per search. */
export const DEFAULT_WEB_SEARCH_COUNT = 5

/** Hard cap on results so a hostile `count` can't ask an upstream for an unbounded page. */
const MAX_WEB_SEARCH_COUNT = 20

/** Clamp a requested result count into a sane range, falling back to the default. */
function clampCount(count: number | undefined): number {
  if (!Number.isFinite(count) || (count ?? 0) <= 0) return DEFAULT_WEB_SEARCH_COUNT
  return Math.min(Math.floor(count as number), MAX_WEB_SEARCH_COUNT)
}

/** Shape of the Brave Web Search response we read (everything else is ignored). */
interface BraveSearchResponse {
  web?: { results?: Array<{ url?: string; title?: string; description?: string }> }
}

/**
 * Brave Search upstream — the default, mirroring what Claude Code uses. The key
 * (`WEB_SEARCH_BRAVE_API_KEY`) stays on the backend; the container only ever reaches
 * this proxy with its session token. Maps Brave's `web.results[].{url,title,description}`
 * onto the normalised `{url,title,content}` shape.
 */
export class BraveWebSearchUpstream implements WebSearchUpstream {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.search.brave.com/res/v1/web/search',
  ) {}

  async search(
    query: string,
    opts: { count?: number; signal?: AbortSignal } = {},
  ): Promise<WebSearchResponse> {
    const url = new URL(this.endpoint)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(clampCount(opts.count)))
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': this.apiKey },
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!res.ok) {
      throw new Error(`Brave search failed (HTTP ${res.status})`)
    }
    const json = (await res.json()) as BraveSearchResponse
    const results = (json.web?.results ?? [])
      .filter((r): r is { url: string; title?: string; description?: string } => {
        return typeof r.url === 'string'
      })
      .map((r) => ({ url: r.url, title: r.title ?? '', content: r.description ?? '' }))
    return { query, results }
  }
}

/** Shape of a SearXNG `format=json` response we read. */
interface SearxngSearchResponse {
  results?: Array<{ url?: string; title?: string; content?: string }>
}

/**
 * SearXNG passthrough upstream — an authenticating reverse proxy to a SearXNG
 * instance the deployment runs (`WEB_SEARCH_SEARXNG_URL`, with an optional bearer
 * via `WEB_SEARCH_SEARXNG_API_KEY` when it sits behind an auth proxy). Zero vendor
 * mapping: SearXNG already aggregates real engines and returns the canonical
 * `results[].{url,title,content}` we pass straight through. Keeps the SearXNG URL +
 * credential off the sandbox (the container only sees this backend proxy).
 */
export class SearxngWebSearchUpstream implements WebSearchUpstream {
  private readonly base: string
  constructor(
    baseUrl: string,
    private readonly apiKey?: string,
    // `trusted` marks a DEPLOYMENT-configured URL (the operator's own SearXNG, e.g. local
    // mode's `http://localhost:8080`) rather than an account-supplied one. The SSRF host
    // guard exists because ACCOUNT URLs are untrusted; a trusted URL may point at a loopback/
    // LAN host, so the host check is skipped for the configured origin only (its own base URL
    // and same-origin redirects). A CROSS-origin redirect is STILL guarded (see `search`), so a
    // trusted-but-compromised upstream can't pivot to an internal/metadata host — and everything
    // else `safeFetch` gives us (manual redirect following, cross-origin credential/body
    // stripping, the response byte cap) still applies. Untrusted (default) instances keep the
    // full guard on every hop.
    private readonly trusted = false,
  ) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  async search(
    query: string,
    opts: { count?: number; signal?: AbortSignal } = {},
  ): Promise<WebSearchResponse> {
    const url = new URL(`${this.base}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    // Re-validate the host on every redirect hop so a permitted base can't 302 the request —
    // with the optional bearer attached — to an internal or metadata host. A trusted deployment
    // upstream trusts ONLY its own configured origin (which may be a loopback/LAN host — see the
    // `trusted` ctor arg): the initial request and any SAME-origin redirect are allowed, but a
    // CROSS-origin redirect is still SSRF-guarded, so a trusted-but-compromised SearXNG can't
    // bounce the request to `169.254.169.254` or another internal host. `safeFetch` runs
    // `assertSafe` on every hop.
    const trustedOrigin = this.trusted ? new URL(this.base).origin : undefined
    const assertSafe =
      trustedOrigin === undefined
        ? assertSafeWebSearchUrl
        : (u: string) => {
            if (new URL(u).origin !== trustedOrigin) assertSafeWebSearchUrl(u)
          }
    const res = await safeFetch(
      url.toString(),
      {
        headers: {
          accept: 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      assertSafe,
      makeSearchError,
    )
    if (!res.ok) {
      throw new Error(`SearXNG search failed (HTTP ${res.status})`)
    }
    const text = await readCappedText(res, MAX_SEARCH_RESPONSE_BYTES, makeSearchError)
    const json = JSON.parse(text) as SearxngSearchResponse
    const limit = clampCount(opts.count)
    const results = (json.results ?? [])
      .filter((r): r is { url: string; title?: string; content?: string } => {
        return typeof r.url === 'string'
      })
      .slice(0, limit)
      .map((r) => ({ url: r.url, title: r.title ?? '', content: r.content ?? '' }))
    return { query, results }
  }
}

/**
 * Build the container web-search upstream from a resolved key config (the per-account
 * settings store), or undefined when none is configured (⇒ container web search stays off
 * for that account). Brave wins when its key is set (the recommended path — one backend
 * key, nothing in the sandbox); else a self-hosted SearXNG the backend reverse-proxies.
 * The keys live in the per-account settings store, not in the container — distinct from the
 * harness's own `BRAVE_SEARCH_API_KEY` / `SEARXNG_URL` autodetect, which only applies to
 * self-hosted runner-pool containers. Used by the proxy to resolve the run's account
 * upstream dynamically.
 */
export function createWebSearchUpstream(cfg: {
  braveApiKey?: string
  searxngUrl?: string
  searxngApiKey?: string
}): WebSearchUpstream | undefined {
  const brave = cfg.braveApiKey?.trim()
  if (brave) return new BraveWebSearchUpstream(brave)
  const searxng = cfg.searxngUrl?.trim()
  if (searxng) return new SearxngWebSearchUpstream(searxng, cfg.searxngApiKey?.trim())
  return undefined
}

/**
 * Build the DEPLOYMENT-DEFAULT web-search upstream from env-supplied config (a facade's own
 * `WEB_SEARCH_*` vars), used by the proxy as a fallback when a run's account has no web-search
 * config of its own. The counterpart to {@link createWebSearchUpstream}: the URL here comes from
 * the deployment operator, not an account admin, so the SearXNG instance is constructed as
 * `trusted` — it may point at a loopback/LAN host (local mode defaults to `http://localhost:8080`)
 * without tripping the account-URL SSRF guard. Brave needs no bypass (fixed public endpoint).
 * Returns undefined when nothing is configured (⇒ no deployment default; the account path still
 * applies).
 */
export function createDefaultWebSearchUpstream(cfg: {
  braveApiKey?: string
  searxngUrl?: string
  searxngApiKey?: string
}): WebSearchUpstream | undefined {
  const brave = cfg.braveApiKey?.trim()
  if (brave) return new BraveWebSearchUpstream(brave)
  const searxng = cfg.searxngUrl?.trim()
  if (searxng) return new SearxngWebSearchUpstream(searxng, cfg.searxngApiKey?.trim(), true)
  return undefined
}
