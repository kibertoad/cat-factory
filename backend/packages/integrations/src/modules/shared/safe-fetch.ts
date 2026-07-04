// Shared SSRF-safe fetch for the *policy-based* (allow-list / private-host) providers —
// the ephemeral-environment and self-hosted runner-pool adapters, whose base URL is an
// org-supplied public host validated against a `UrlSafetyPolicy` (not a single fixed
// host). Both share the same concerns: (1) follow redirects by hand and re-run the SSRF
// guard on EVERY hop, so a permitted first hop can't 302 the request — and its
// secret-bearing body — to an internal address (e.g. 169.254.169.254) or downgrade it to
// http; (2) on a CROSS-ORIGIN hop, strip credential-bearing headers and drop the request
// body before following, so the request's secrets can't be forwarded to a *different*
// (public but attacker-chosen) host either; (3) bound the bytes read off any response so a
// hostile/huge body can't OOM the isolate. The host-*pinned* providers (Figma/Notion/…)
// use the sibling `documents/http.ts` helper instead; this one takes an injected
// `assertSafe` so the caller supplies the policy check, and an error factory so each
// provider keeps its own error type.

/** Max redirect hops the revalidating fetch will follow before giving up. */
export const DEFAULT_MAX_REDIRECTS = 5

/** Builds the caller's HTTP error type (carrying a status) for redirect/size failures. */
export type MakeHttpError = (status: number, message: string) => Error

/**
 * Request headers that carry a credential and MUST NOT survive a cross-origin redirect.
 * (The platform `fetch` strips `Authorization` on a cross-origin redirect; we bypass it
 * with `redirect: 'manual'`, so we re-establish the same stripping by hand — and add
 * `cookie`/`proxy-authorization` for completeness.)
 */
const SENSITIVE_REDIRECT_HEADERS = ['authorization', 'proxy-authorization', 'cookie']

/**
 * Drop the request body and strip credential-bearing headers from an init — applied when a
 * redirect crosses origins so neither a secret-bearing body (the runner-pool dispatch
 * payload / OAuth `client_secret` form) nor an `Authorization` header is forwarded to the
 * new host. Deliberately STRICTER than the WHATWG fetch spec (which keeps the body on a
 * 307/308): our bodies carry credentials, so we drop them on every cross-origin hop.
 */
function stripCredentialsForCrossOrigin(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers)
  for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name)
  return { ...init, headers, body: undefined }
}

/**
 * `fetch` with redirects followed by hand so `assertSafe` runs against EVERY hop, not
 * just the first URL. With the default `redirect: 'follow'` a permitted host can 302 to
 * an internal target — or downgrade https→http — and the runtime would follow it
 * unchecked. We force `redirect: 'manual'`, re-resolve the `Location` against the current
 * URL, and re-run `assertSafe` before following. `assertSafe` throws (as an invalid
 * initial URL would) when a hop is disallowed. On a cross-origin hop the request body +
 * credential headers are stripped (see {@link stripCredentialsForCrossOrigin}) so a
 * permitted host can't bounce the secrets to a *different* public host.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
  assertSafe: (u: string) => void,
  makeError: MakeHttpError,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  let current = url
  let currentInit = init
  for (let hop = 0; ; hop++) {
    assertSafe(current)
    const res = await doFetch(current, { ...currentInit, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      if (hop >= maxRedirects) {
        throw makeError(502, 'Too many redirects')
      }
      // Resolve relative redirects against the current URL, then re-validate on the
      // next loop iteration. Crossing origins strips the body + credential headers so
      // the request's secrets never reach a host other than the one that received them.
      const next = new URL(location, current)
      if (next.origin !== new URL(current).origin) {
        currentInit = stripCredentialsForCrossOrigin(currentInit)
      }
      current = next.toString()
      continue
    }
    return res
  }
}

/**
 * Read a response body with a running byte cap so a hostile/huge response can't OOM the
 * isolate. Checks the declared Content-Length first, then enforces the cap while
 * streaming. When `throwOnOverflow` is false (error snippets) the body is truncated to
 * the cap instead of throwing.
 */
export async function readCappedText(
  res: Response,
  maxBytes: number,
  makeError: MakeHttpError,
  throwOnOverflow = true,
): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared && Number(declared) > maxBytes && throwOnOverflow) {
    throw makeError(502, 'Response too large')
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
        if (throwOnOverflow) {
          throw makeError(502, 'Response too large')
        }
        chunks.push(value)
        break
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(merged).slice(0, maxBytes)
}
