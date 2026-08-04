// The transport: the one place that knows about auth, retries, timeouts and error mapping.
//
// The 38 generated operation methods do nothing but describe a request and hand it here, so any
// change to HOW the SDK talks to a deployment is a change to this file alone.

import {
  CatFactoryConnectionError,
  CatFactoryDecodeError,
  CatFactoryError,
  CatFactoryTimeoutError,
  toApiError,
} from './errors.ts'
import { type EventStream, readEventStream } from './sse.ts'

/** Per-call overrides. Every operation method takes one as its last argument. */
export interface RequestOptions {
  /** Abort the call from the outside (composed with the client's own timeout). */
  signal?: AbortSignal
  /** Override the client's `timeoutMs` for this call. `0` disables the deadline. */
  timeoutMs?: number
  /** Extra headers, merged over the client's. */
  headers?: Record<string, string>
  /**
   * Override the retry budget for this call. Note the default policy below: a non-idempotent
   * request is never retried automatically, so raising this does not make `POST /jobs`
   * retry-safe.
   */
  maxRetries?: number
}

export interface ClientOptions {
  /** The deployment's origin, e.g. `https://cat-factory.example.com`. */
  baseUrl: string
  /** A public-API key: `cf_live_<keyId>.<secret>`. */
  apiKey: string
  /** Per-request deadline in ms; `0` disables it. Default 30_000. */
  timeoutMs?: number
  /** Retries for a RETRIABLE failure (see `isRetriable`). Default 2. */
  maxRetries?: number
  /** Headers sent on every request. */
  headers?: Record<string, string>
  /** Swap the HTTP implementation (a proxy agent, a test double). Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Prefixed to `User-Agent`, so a deployment's logs can attribute calls to your integration. */
  userAgent?: string
}

export interface RequestSpec {
  method: string
  path: string
  body?: unknown
  query?: Record<string, unknown>
  options: RequestOptions
}

/** SDK version, stamped into `User-Agent`. Kept in step with package.json by `check:sdk`. */
export const SDK_VERSION = '0.6.0'

/**
 * Percent-encode a path parameter.
 *
 * `encodeURIComponent` and not a raw interpolation: an id is server-supplied but travels through
 * a caller's own storage, and one carrying a `/` or a `?` would otherwise silently re-target the
 * request at a different route rather than 404 on the id it names.
 */
export function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

/** Whether a failed attempt may be replayed. */
function isRetriable(method: string, status: number | null): boolean {
  // A transport failure with no response (status null) tells us nothing about whether the
  // server acted, so only a method that is idempotent BY DEFINITION may be replayed. `POST
  // /jobs` and `POST /tasks/:id/start` both cost real LLM work, and a duplicate is not
  // something the SDK may decide to risk on the caller's behalf.
  const idempotent = method === 'GET' || method === 'HEAD' || method === 'DELETE'
  if (!idempotent) return false
  if (status === null) return true
  return status === 429 || status === 502 || status === 503 || status === 504
}

/** Full jitter on an exponential base, so a fleet of clients does not retry in lockstep. */
function backoffMs(attempt: number): number {
  return Math.round(Math.random() * Math.min(8_000, 250 * 2 ** attempt))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Serialize the query bag, dropping absent values so `?limit=undefined` is impossible. */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.append(key, String(value))
  }
  const rendered = params.toString()
  return rendered ? `?${rendered}` : ''
}

export class Transport {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly headers: Record<string, string>
  private readonly doFetch: typeof globalThis.fetch

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new Error('cat-factory SDK: `baseUrl` is required.')
    if (!options.apiKey) throw new Error('cat-factory SDK: `apiKey` is required.')
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxRetries = options.maxRetries ?? 2
    const agent = options.userAgent ? `${options.userAgent} ` : ''
    this.headers = {
      accept: 'application/json',
      'user-agent': `${agent}cat-factory-sdk-js/${SDK_VERSION}`,
      ...options.headers,
    }
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Perform a request, returning the decoded JSON body. */
  async request<T>(spec: RequestSpec): Promise<T> {
    const response = await this.send(spec, 'application/json')
    const text = await response.text()
    if (text.length === 0) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch (cause) {
      throw new CatFactoryDecodeError(
        `cat-factory SDK: ${spec.method} ${spec.path} returned a body that is not JSON.`,
        text,
        { cause },
      )
    }
  }

  /** Perform a request whose success carries no body (a 204). */
  async requestNoContent(spec: RequestSpec): Promise<void> {
    const response = await this.send(spec, 'application/json')
    // Drain, so a keep-alive connection is returned to the pool rather than held open.
    await response.arrayBuffer()
  }

  /**
   * Open a server-sent event stream. Deliberately NOT retried: a reconnect would replay the
   * stream from its start, and the caller — who knows which events it has already acted on —
   * is the only party that can decide whether that is safe.
   */
  async stream(spec: RequestSpec): Promise<EventStream> {
    const response = await this.send(
      { ...spec, options: { ...spec.options, maxRetries: 0 } },
      'text/event-stream',
    )
    if (!response.body) {
      throw new CatFactoryConnectionError('cat-factory SDK: the event stream carried no body.')
    }
    return readEventStream(response.body)
  }

  private async send(spec: RequestSpec, accept: string): Promise<Response> {
    const url = `${this.baseUrl}${spec.path}${buildQuery(spec.query)}`
    const budget = spec.options.maxRetries ?? this.maxRetries
    let lastError: unknown

    for (let attempt = 0; ; attempt += 1) {
      const timeoutMs = spec.options.timeoutMs ?? this.timeoutMs
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(spec.options.signal?.reason)
      spec.options.signal?.addEventListener('abort', onAbort, { once: true })
      const timer =
        timeoutMs > 0 ? setTimeout(() => controller.abort(new DeadlineReached()), timeoutMs) : null

      try {
        const response = await this.doFetch(url, {
          method: spec.method,
          headers: {
            // Client headers, then per-call ones, then the three the SDK owns — which therefore
            // win. An `authorization` the transport did not build, or an `accept` that disagrees
            // with how the response is about to be read, are not customisations; they are the
            // client not working. All four SDKs apply this same precedence.
            ...this.headers,
            ...spec.options.headers,
            accept,
            authorization: `Bearer ${this.apiKey}`,
            ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: controller.signal,
        })
        if (response.ok) return response

        const requestId = response.headers.get('x-request-id')
        if (attempt < budget && isRetriable(spec.method, response.status)) {
          // Honour `Retry-After` when the server states one: it is the deployment's own
          // knowledge of when the limit clears, which beats our blind backoff curve.
          await sleep(retryAfterMs(response) ?? backoffMs(attempt))
          continue
        }
        throw toApiError(response.status, await readBodySafely(response), requestId)
      } catch (error) {
        // The CALLER's cancellation is checked FIRST, and on the signal rather than on the shape
        // of the error: `abort(reason)` rejects the fetch with that reason verbatim, so a caller
        // who aborts with a plain `new Error('user navigated away')` produces something whose
        // `name` is not `AbortError`. Gating on the name alone let exactly that case fall through
        // to the retry branch below — a cancelled GET was replayed to the budget and then
        // reported as a connection failure, which is neither what happened nor what was asked
        // for. A cancellation is the outcome the caller chose; it is never retried, and never
        // re-wrapped.
        if (spec.options.signal?.aborted) throw spec.options.signal.reason ?? error
        if (error instanceof Error && error.name === 'AbortError') {
          // Ours, then: the deadline. Distinct from the above because a timeout is something the
          // caller may want to retry with a longer budget.
          throw new CatFactoryTimeoutError(
            `cat-factory SDK: ${spec.method} ${spec.path} exceeded ${timeoutMs}ms.`,
            { cause: error },
          )
        }
        // An error we already classified (an API refusal) propagates untouched.
        if (isSdkError(error)) throw error
        lastError = error
        if (attempt < budget && isRetriable(spec.method, null)) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw new CatFactoryConnectionError(
          `cat-factory SDK: ${spec.method} ${spec.path} failed to reach ${this.baseUrl}.`,
          { cause: lastError },
        )
      } finally {
        if (timer) clearTimeout(timer)
        spec.options.signal?.removeEventListener('abort', onAbort)
      }
    }
  }
}

/** Marker carried by the abort reason our own deadline raises. */
class DeadlineReached extends Error {
  override readonly name = 'AbortError'
}

/**
 * An error this SDK already classified. It propagates untouched rather than being re-wrapped as
 * a connection failure: an API refusal that reached us through the `catch` below is a verdict,
 * not a transport fault, and re-wrapping it would hide the status the caller needs.
 */
function isSdkError(error: unknown): boolean {
  return error instanceof CatFactoryError
}

/** Read a failed response's body without letting a decode fault mask the real failure. */
async function readBodySafely(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** `Retry-After` in ms — seconds or an HTTP date — or null when absent/unparsable. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const date = Date.parse(header)
  if (Number.isNaN(date)) return null
  return Math.max(0, Math.min(date - Date.now(), 60_000))
}
