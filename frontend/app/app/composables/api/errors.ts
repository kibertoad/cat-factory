/**
 * A failed API call, normalised to a real `Error`.
 *
 * The contract client (`sendByApiContract`) reports a contract-declared non-2xx as a
 * plain `{ statusCode, headers, body }` value — NOT an `Error` — with the parsed
 * `{ error: { code, message, details } }` envelope under `body`. Throwing that bare
 * object breaks every `error instanceof Error` check (they fall to `String(error)` =
 * `"[object Object]"`) and hides the server's message. `sendContract` wraps it in this
 * class so call sites get `instanceof Error`, a real `.message` (the server's), the
 * `.statusCode`, and the typed `.envelope`.
 */
export class ApiError extends Error {
  readonly statusCode: number
  /** The parsed response body (the `{ error: {...} }` envelope for our controllers). */
  readonly body: unknown

  constructor(statusCode: number, body: unknown) {
    super(envelopeOf(body)?.message ?? `Request failed (HTTP ${statusCode})`)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.body = body
  }

  /** The `{ code, message, details, issues }` envelope, when the body carries one. */
  get envelope(): ApiErrorEnvelope | undefined {
    return envelopeOf(this.body)
  }
}

/** The error envelope every controller emits (`handleError` / contract request-validator). */
export interface ApiErrorEnvelope {
  code?: string
  message?: string
  details?: unknown
  issues?: { path?: string; message: string }[]
}

/** Read the `{ error: {...} }` envelope out of a parsed response body, else undefined. */
function envelopeOf(body: unknown): ApiErrorEnvelope | undefined {
  if (!body || typeof body !== 'object') return undefined
  const error = (body as { error?: unknown }).error
  return error && typeof error === 'object' ? (error as ApiErrorEnvelope) : undefined
}

/**
 * Pull the server error envelope out of any thrown API error, regardless of which client
 * produced it: the contract client (`ApiError`, body under `.body`) or the legacy `$fetch`
 * path (ofetch `FetchError`, body under `.data`). Returns undefined for network faults or
 * non-API errors.
 */
export function apiErrorEnvelope(error: unknown): ApiErrorEnvelope | undefined {
  if (error instanceof ApiError) return error.envelope
  const e = error as { body?: unknown; data?: unknown }
  return envelopeOf(e?.body) ?? envelopeOf(e?.data)
}

/** The HTTP status of a thrown API error, when present (contract client or `$fetch`). */
export function apiErrorStatus(error: unknown): number | undefined {
  const e = error as { statusCode?: unknown; status?: unknown }
  if (typeof e?.statusCode === 'number') return e.statusCode
  if (typeof e?.status === 'number') return e.status
  return undefined
}
