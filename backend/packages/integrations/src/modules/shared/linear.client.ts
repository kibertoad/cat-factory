import { ValidationError } from '@cat-factory/kernel'

// Shared Linear GraphQL transport. Linear exposes a single GraphQL endpoint, so
// every Linear consumer (the document source, the task source, ticket filing and
// PR writeback) talks to the SAME host with the SAME auth scheme — this module is
// that one place. It is runtime-neutral (global `fetch`, present on both the
// Cloudflare and Node facades) and host-pinned to `api.linear.app`, following the
// per-hop redirect guard + capped body read the NotionProvider uses so a hostile
// redirect can't leak the API key or OOM the isolate.
//
// OAuth-ready seam: auth is an opaque object today carrying a personal API key
// (sent as the raw `authorization` value). When OAuth lands, a `{ token }` variant
// emits `authorization: Bearer <token>` with no change to any caller — see
// `linearAuthHeader`.

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const LINEAR_API_HOST = 'api.linear.app'
const USER_AGENT = 'cat-factory'
/** Bound the redirect chain so the fixed API host can't 302 us elsewhere. */
const MAX_REDIRECTS = 5
/** Hard cap on the bytes read off any response body, to protect the isolate. */
const MAX_RESPONSE_BYTES = 5_000_000

/**
 * How a Linear request authenticates. A personal API key is sent as the raw
 * `authorization` header value (Linear's documented scheme for personal keys); a
 * future OAuth access token is sent as a `Bearer` token. Modelled as a union so
 * adding OAuth is a new variant, not a caller change.
 */
export type LinearAuth = { apiKey: string } | { token: string }

/** Build the `authorization` header for a Linear request (API key raw, OAuth `Bearer`). */
export function linearAuthHeader(auth: LinearAuth): string {
  return 'token' in auth ? `Bearer ${auth.token}` : auth.apiKey
}

/**
 * Resolve a stored Linear credential bag into the {@link LinearAuth} the client
 * needs. A connection may hold an OAuth access `token` (the OAuth connect flow) or
 * a personal `apiKey` (the manual connect form); the token wins when both are
 * present. Throws when neither is set — every Linear caller resolves auth through
 * this one helper so the API-key/OAuth choice never diverges between call sites.
 */
export function linearAuthFromCredentials(credentials: {
  token?: string
  apiKey?: string
}): LinearAuth {
  if (credentials.token) return { token: credentials.token }
  if (credentials.apiKey) return { apiKey: credentials.apiKey }
  throw new ValidationError('Linear connection has neither an OAuth token nor an API key')
}

/** Carries the HTTP status so callers can surface a meaningful error. */
export class LinearApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'LinearApiError'
  }
}

/**
 * The minimal slice of the Fetch API the GraphQL POST needs (no DOM lib). Matches
 * the `FetchLike` the tracker/writeback services inject, so a fake `fetch` drives
 * both. `body` is always set (GraphQL is POST-only), so it is required here.
 */
export type LinearFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>

/** A parsed GraphQL envelope: `data` on success, `errors[]` on failure. */
interface GraphqlEnvelope<T> {
  data?: T | null
  errors?: { message?: string }[]
}

/**
 * Validate a parsed GraphQL envelope and return its `data`. Pure (no I/O) so both
 * the safe global-fetch client below and the FetchLike-driven tracker/writeback
 * services share one error policy. Throws {@link LinearApiError} on a non-OK
 * status, a top-level `errors[]`, or a missing `data`.
 */
export function unwrapLinearData<T>(status: number, ok: boolean, parsed: unknown): T {
  const envelope = (parsed ?? {}) as GraphqlEnvelope<T>
  if (!ok) {
    const detail = envelope.errors?.map((e) => e.message).join('; ')
    throw new LinearApiError(status, `Linear GraphQL → ${status}${detail ? `: ${detail}` : ''}`)
  }
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    const detail = envelope.errors.map((e) => e.message ?? 'unknown error').join('; ')
    throw new LinearApiError(status, `Linear GraphQL error: ${detail}`)
  }
  if (envelope.data == null) {
    throw new LinearApiError(502, 'Linear GraphQL returned no data')
  }
  return envelope.data
}

/** The header set every Linear GraphQL POST sends (API key raw, OAuth `Bearer`). */
export function linearRequestHeaders(auth: LinearAuth): Record<string, string> {
  return {
    authorization: linearAuthHeader(auth),
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  }
}

/**
 * Run a Linear GraphQL operation through a caller-injected `fetch` (the write path:
 * ticket filing + PR writeback), returning the validated `data`. This is the single
 * place those services build the request + apply the {@link unwrapLinearData} error
 * policy, so the header set and error handling can't drift between call sites. The
 * read/import path uses {@link LinearGraphqlClient} instead (it additionally pins
 * the host + caps the body on the real `fetch`). `fetchImpl` is injected so the
 * services stay unit-testable with a fake transport (mirrors the Jira pattern).
 */
export async function postLinearGraphql<T>(
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  auth: LinearAuth,
  document: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: linearRequestHeaders(auth),
    body: JSON.stringify({ query: document, variables }),
  })
  return unwrapLinearData<T>(res.status, res.ok, await res.json().catch(() => null))
}

/**
 * The Linear API host is fixed, so any redirect must stay on `api.linear.app`
 * over https — a redirect off-host (e.g. to an internal address) is treated as an
 * SSRF attempt and rejected. Mirrors the NotionProvider guard.
 */
function assertSafeLinearUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LinearApiError(502, `Linear request URL is invalid: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new LinearApiError(502, 'Linear request must use https')
  }
  if (parsed.hostname.toLowerCase() !== LINEAR_API_HOST) {
    throw new LinearApiError(502, `Linear redirect to a disallowed host: ${parsed.hostname}`)
  }
}

/** `fetch` with redirects followed by hand so the host guard runs against EVERY hop. */
async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  let current = url
  for (let hop = 0; ; hop++) {
    assertSafeLinearUrl(current)
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      if (hop >= MAX_REDIRECTS) throw new LinearApiError(502, 'Linear returned too many redirects')
      current = new URL(location, current).toString()
      continue
    }
    return res
  }
}

/** Read a response body with a running byte cap so a huge response can't OOM the isolate. */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) {
    throw new LinearApiError(502, 'Linear response too large')
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
        throw new LinearApiError(502, 'Linear response too large')
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

/**
 * A thin, safe Linear GraphQL client used by the document + task providers (the
 * read/import path). It runs the host-pinned redirect guard + capped read on the
 * real `fetch`. The ticket-filing / writeback services do NOT use this class: they
 * post through their own injected `FetchLike` (for testability, matching the Jira
 * pattern) and share only the pure `unwrapLinearData` / `linearAuthHeader` helpers.
 */
export class LinearGraphqlClient {
  constructor(private readonly auth: LinearAuth) {}

  /** Run a GraphQL document and return its validated `data`. */
  async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await safeFetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: linearAuthHeader(this.auth),
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ query: document, variables }),
    })
    const text = await readCappedText(res, MAX_RESPONSE_BYTES).catch(() => '')
    const parsed = (() => {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    })()
    return unwrapLinearData<T>(res.status, res.ok, parsed)
  }
}
