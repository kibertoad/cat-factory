// Shared HTTP helpers for the host-pinned document-source providers (Figma, Claude
// Design, …). Every provider that talks to a *fixed* third-party API host shares the
// same two concerns: (1) keep the credential on the intended host — follow redirects
// by hand and re-validate every hop so a 302 can't chase the token to an internal
// address (SSRF) or downgrade it to http; (2) bound the bytes read off any response so
// a hostile/huge body can't OOM the isolate. Notion/Confluence each grew their own copy
// of this; it is hoisted here so a new fixed-host provider reuses it instead of
// re-deriving the per-hop guard (and the latent bug of forgetting it).
//
// The helper is host-*pinned*, not host-*allow-listed*: it serves providers whose API
// lives at a single known host. A site-configurable provider (Confluence) keeps its own
// guard because its allowed host is per-connection, not a constant.

/** Carries the HTTP status so a provider can surface a meaningful error to the caller. */
export class DocumentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DocumentHttpError'
  }
}

/**
 * Assert a request/redirect URL stays on the provider's fixed `host` over https. A
 * redirect off-host (e.g. to a link-local metadata address) or an http downgrade is
 * treated as an SSRF attempt and rejected. Throws a plain `Error` so it stays trivially
 * unit-testable without a network; the caller maps it to a {@link DocumentHttpError}.
 * `label` names the provider in the message (e.g. `Figma`, `Claude Design`).
 */
export function assertHostPinned(url: string, host: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label} request URL is invalid: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} request must use https`)
  }
  if (parsed.hostname.toLowerCase() !== host.toLowerCase()) {
    throw new Error(`${label} redirect to a disallowed host: ${parsed.hostname}`)
  }
}

/** Bound the redirect chain so the fixed API host can't 302 us elsewhere indefinitely. */
const DEFAULT_MAX_REDIRECTS = 5

export interface HostPinnedFetchOptions {
  /** The single host this provider's API lives on (e.g. `api.figma.com`). */
  host: string
  /** Provider name used in error messages. */
  label: string
  /** Max redirect hops before giving up (default 5). */
  maxRedirects?: number
}

/**
 * Build a `fetch` that follows redirects **by hand** so {@link assertHostPinned} runs
 * against EVERY hop. With the default `redirect: 'follow'` a 302 from the API could be
 * chased to an internal target (or downgraded to http), leaking the credential. We force
 * `redirect: 'manual'`, re-resolve the `Location`, and re-validate before each hop.
 */
export function createHostPinnedFetch(
  opts: HostPinnedFetchOptions,
): (url: string, init: RequestInit) => Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  return async function safeFetch(url: string, init: RequestInit): Promise<Response> {
    let current = url
    for (let hop = 0; ; hop++) {
      try {
        assertHostPinned(current, opts.host, opts.label)
      } catch (err) {
        throw new DocumentHttpError(
          502,
          err instanceof Error ? err.message : `${opts.label} request blocked`,
        )
      }
      const res = await fetch(current, { ...init, redirect: 'manual' })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) return res
        if (hop >= maxRedirects) {
          throw new DocumentHttpError(502, `${opts.label} returned too many redirects`)
        }
        current = new URL(location, current).toString()
        continue
      }
      return res
    }
  }
}

/**
 * Read a response body with a running byte cap so a hostile/huge response can't OOM the
 * isolate. Checks the declared Content-Length first, then enforces the cap while
 * streaming. `label` names the provider in the error message.
 */
export async function readCappedText(
  res: Response,
  maxBytes: number,
  label = 'Response',
): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) {
    throw new DocumentHttpError(502, `${label} response too large`)
  }
  const body = res.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new DocumentHttpError(502, `${label} response too large`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(merged)
}
