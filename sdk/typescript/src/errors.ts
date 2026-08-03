// The SDK's error hierarchy.
//
// Every failure the API reports arrives as one envelope — `{ error: { code, message, details?,
// issues? } }` — and the SDK turns it into a typed exception. Which class you get is decided by
// the HTTP STATUS, never by `code`.
//
// That split is deliberate. `/api/v1` puts two families of value in `error.code`: the status-class
// codes (`validation`, `not_found`, `conflict`, …) and codes specific to this surface
// (`insufficient_scope`, `invalid_cursor`, `pipeline_not_public`, `too_many_active_runs`, …), and
// the surface is additive forever — new codes appear without a major version. So the status is the
// part that is safe to branch a CLASS on, and `code` is exposed verbatim as a plain string for the
// caller to branch on precisely. Narrowing `code` to a closed union in the SDK would mean an
// SDK release is required before a caller can even NAME a refusal the server already sends, and
// a copy of the vocabulary here would be a second place for it to go stale. The authoritative
// list is `backend/docs/public-api.md`.

/** The wire error envelope every `/api/v1` failure carries. */
export interface ApiErrorBody {
  error: {
    /**
     * Machine-readable. Either a status-class code (`validation`, `not_found`, `conflict`,
     * `unauthorized`, `forbidden`, `credential_required`, `rate_limited`, `unavailable`,
     * `internal`) or one specific to this surface (`insufficient_scope`, `invalid_cursor`,
     * `pipeline_not_public`, …). Branch on this, never on `message`.
     */
    code: string
    /** Operator prose. Not localized, and not a stable identifier — do not branch on it. */
    message: string
    /** Cause detail, shape depending on `code`. */
    details?: unknown
    /** Per-field validation failures, on a 400 whose body or query did not parse. */
    issues?: { path?: string; message: string }[]
  }
}

/** Base class for everything this SDK throws, so one `catch` can bound the whole client. */
export class CatFactoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** The request never produced an HTTP response: DNS, TCP, TLS, or an aborted socket. */
export class CatFactoryConnectionError extends CatFactoryError {}

/** The request exceeded the client-side deadline (`timeoutMs`), so no verdict was reached. */
export class CatFactoryTimeoutError extends CatFactoryError {}

/**
 * A 2xx response whose body was not the JSON the contract promises — in practice a proxy or
 * gateway answering in the deployment's place. Carries the raw text, because "invalid JSON" on
 * its own does not tell you that something in front of the backend returned an HTML error page.
 */
export class CatFactoryDecodeError extends CatFactoryError {
  readonly rawBody: string
  constructor(message: string, rawBody: string, options?: { cause?: unknown }) {
    super(message, options)
    this.rawBody = rawBody
  }
}

/**
 * The server answered, and the answer was a refusal. Subclasses below name the status CLASS;
 * `code` names the specific cause.
 */
export class CatFactoryApiError extends CatFactoryError {
  /** The HTTP status. */
  readonly status: number
  /** The machine-readable `error.code` — see the note at the top of this file. */
  readonly code: string
  /** `error.details`, whose shape depends on `code`. */
  readonly details: unknown
  /** Per-field validation failures, when the server reported any. */
  readonly issues: { path?: string; message: string }[]
  /**
   * The `X-Request-Id` of the failing call. Every response carries one (the backend mints or
   * adopts it in `mountRequestLogging`), and it is the id to quote when reporting a fault —
   * it is what correlates this call with the deployment's own logs.
   */
  readonly requestId: string | null
  /** The raw body, for a failure whose `details` this SDK does not model. */
  readonly body: unknown

  constructor(args: {
    status: number
    code: string
    message: string
    details?: unknown
    issues?: { path?: string; message: string }[]
    requestId: string | null
    body: unknown
  }) {
    super(`${args.status} ${args.code}: ${args.message}`)
    this.status = args.status
    this.code = args.code
    this.details = args.details
    this.issues = args.issues ?? []
    this.requestId = args.requestId
    this.body = args.body
  }
}

/** 400 / 422 — the request was malformed, or a domain rule refused it. */
export class CatFactoryValidationError extends CatFactoryApiError {}
/** 401 — no key, or a key that has been revoked. */
export class CatFactoryUnauthorizedError extends CatFactoryApiError {}
/** 403 — a valid key whose scope is too low (`insufficient_scope`), or a forbidden action. */
export class CatFactoryForbiddenError extends CatFactoryApiError {}
/** 404 — no such resource, or one outside this key's workspace (the two are indistinguishable). */
export class CatFactoryNotFoundError extends CatFactoryApiError {}
/** 409 — the resource is not in a state that admits this action. */
export class CatFactoryConflictError extends CatFactoryApiError {}
/** 428 — a credential the action needs has not been supplied. */
export class CatFactoryCredentialRequiredError extends CatFactoryApiError {}
/** 429 — rate limited, or a counted cap is already full (`too_many_active_runs`). */
export class CatFactoryRateLimitedError extends CatFactoryApiError {}
/** 5xx — the deployment faulted or a dependency it needs is unavailable. */
export class CatFactoryServerError extends CatFactoryApiError {}

const BY_STATUS: Record<number, typeof CatFactoryApiError> = {
  400: CatFactoryValidationError,
  401: CatFactoryUnauthorizedError,
  403: CatFactoryForbiddenError,
  404: CatFactoryNotFoundError,
  409: CatFactoryConflictError,
  422: CatFactoryValidationError,
  428: CatFactoryCredentialRequiredError,
  429: CatFactoryRateLimitedError,
}

/**
 * Build the typed error for a failed response.
 *
 * A body that is not the documented envelope (a proxy's HTML error page, a truncated stream)
 * still yields a usable error: the status is always known, and the unparsed body is retained on
 * `body` rather than discarded, so a caller diagnosing an unexpected failure is not left with
 * "something went wrong".
 */
export function toApiError(
  status: number,
  body: unknown,
  requestId: string | null,
): CatFactoryApiError {
  const envelope =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as ApiErrorBody).error
      : null
  const Ctor = BY_STATUS[status] ?? (status >= 500 ? CatFactoryServerError : CatFactoryApiError)
  return new Ctor({
    status,
    code: envelope?.code ?? (status >= 500 ? 'internal' : 'unknown'),
    message: envelope?.message ?? `HTTP ${status}`,
    details: envelope?.details,
    issues: envelope?.issues,
    requestId,
    body,
  })
}
