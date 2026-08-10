// Domain-level errors. The core throws these; the facade's error handler maps
// them to HTTP status codes. Keeping them framework-agnostic means the same core
// can be wrapped by a different transport (queue consumer, RPC, CLI) unchanged.

/**
 * The status class carried on the wire as `error.code`. Defined in `@cat-factory/contracts`
 * and re-exported here, exactly like {@link ConflictReason} below: it is a shape the SPA also
 * reads (to present a failure generically when no `details.reason` narrows it), so a code added
 * on one side must be honoured on the other.
 */
export type { DomainErrorCode } from '@cat-factory/contracts'
import type { DomainErrorCode } from '@cat-factory/contracts'
import { errorChainText } from '../shared/error-chain.logic.js'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /**
     * Optional machine-readable detail the facade surfaces alongside the error
     * (e.g. which vendor + why a personal credential is required), so a client can
     * react precisely — prompt for a password vs offer to connect a subscription —
     * without string-matching the message.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** A referenced entity does not exist (→ 404). */
export class NotFoundError extends DomainError {
  constructor(
    entity: string,
    id: string,
    /**
     * Optional machine-readable context (a `reason` code), mirroring {@link ValidationError} and
     * {@link UnavailableError}. It earns its place where ONE endpoint answers 404 for causes that
     * need different reactions: the artifact blob route refuses both an id its workspace does not
     * hold and a row whose bytes are gone from the blob backend, and only a reason tells a caller
     * whether to stop asking or to report a storage fault.
     */
    details?: Record<string, unknown>,
  ) {
    super('not_found', `${entity} '${id}' not found`, details)
  }
}

/** Structurally valid but violates a domain rule (→ 422). */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    /** Optional machine-readable context (e.g. a `reason` code) the engine or facade can react
     *  to precisely — mirrors {@link DomainError.details}. */
    details?: Record<string, unknown>,
  ) {
    super('validation', message, details)
  }
}

/**
 * A distinct, machine-readable code for a 409 conflict so a client can react to a
 * SPECIFIC conflict precisely (e.g. open the AI-provider setup for
 * `providers_unconfigured`) instead of string-matching the human message — the
 * conflict analogue of {@link CredentialRequiredReason}. Surfaced on the wire under
 * `error.details.reason`. Optional: a conflict with no client-specific handling can
 * omit it and just carry its message.
 *
 * The canonical list lives in `@cat-factory/contracts` (a wire shape shared by the SPA),
 * re-exported here so `ConflictError` and the route contracts can't drift.
 */
export type { ConflictReason } from '@cat-factory/contracts'
import type { ConflictReason } from '@cat-factory/contracts'

/** Conflicts with current state (→ 409). */
export class ConflictError extends DomainError {
  constructor(
    message: string,
    /** Machine-readable {@link ConflictReason} for the client (under `details.reason`). */
    reason?: ConflictReason,
    /** Extra machine-readable context merged alongside `reason` (e.g. the offending model ids). */
    details?: Record<string, unknown>,
  ) {
    super('conflict', message, reason ? { reason, ...details } : details)
  }
}

/**
 * Why a personal (individual-usage) subscription credential can't be used right now.
 *  - `no_subscription`     — the user has no stored credential for the vendor.
 *  - `password_required`   — a credential exists but the request carried no password
 *                            (or none is cached) to unlock it.
 *  - `wrong_password`      — the supplied password did not decrypt the credential.
 *  - `subscription_expired`— the stored subscription's own expiry has passed; renew it.
 */
export type CredentialRequiredReason =
  | 'no_subscription'
  | 'password_required'
  | 'wrong_password'
  | 'subscription_expired'

/**
 * A user-scoped personal credential is needed before this action can proceed (→ 428
 * Precondition Required). Carries the vendor + reason so the client prompts for a
 * password or offers to connect/renew the subscription, rather than failing opaquely.
 * Used by the individual-usage restricted mode (e.g. Claude personal subscriptions).
 */
export class CredentialRequiredError extends DomainError {
  constructor(message: string, details: { vendor: string; reason: CredentialRequiredReason }) {
    super('credential_required', message, details)
  }
}

/**
 * The caller is authenticated and CAN see the resource, but lacks the capability for
 * this action (→ 403 Forbidden). Distinct from a {@link NotFoundError} 404, which is
 * how workspace RBAC hides a board the caller may not even know exists: 403 reveals
 * only insufficiency (the caller already sees the workspace), 404 reveals nothing. Do
 * NOT copy the account tier's legacy `requireAdmin` 409 shape into workspace enforcement.
 */
export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden', details?: Record<string, unknown>) {
    super('forbidden', message, details)
  }
}

/**
 * A capability this deployment has not wired is required for the action (→ 503 Service
 * Unavailable). BY FAR the most common hand-rolled envelope before it had a class — an
 * opt-in integration (task sources, the skills library, artifact storage, an OAuth
 * provider) that a facade only builds when configured, so its controller answers 503
 * rather than 404.
 *
 * `reason` matters more here than anywhere else: "not configured" is the one error class
 * whose remedy is always a specific setup screen, and a client cannot route to it by
 * string-matching prose. Carry the machine-readable code and let the SPA translate.
 */
export class UnavailableError extends DomainError {
  constructor(
    message: string,
    /** Machine-readable code for the client (under `details.reason`), e.g. which integration. */
    reason?: string,
    /** Extra machine-readable context merged alongside `reason`. */
    details?: Record<string, unknown>,
  ) {
    super('unavailable', message, reason ? { reason, ...details } : details)
  }
}

/**
 * The caller is NOT authenticated (or its credential/signature did not verify) → 401.
 * Distinct from {@link ForbiddenError}, which is an authenticated caller lacking a
 * capability: 401 says "sign in", 403 says "you can't do this".
 *
 * Webhook receivers use this for a failed HMAC check. Keep those messages coarse — a
 * signature verifier that distinguishes "no header" from "bad digest" is an oracle — and
 * put the operator-facing distinction in a log line, not the envelope.
 */
export class UnauthorizedError extends DomainError {
  constructor(
    message = 'Unauthorized',
    /** Machine-readable code for the client (under `details.reason`). */
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super('unauthorized', message, reason ? { reason, ...details } : details)
  }
}

/**
 * The caller (or the deployment, against an upstream) exceeded a rate limit → 429.
 *
 * `retryAfterSeconds` rides `details` rather than a header because the envelope is what
 * survives every hop this platform has — a queue consumer and the durable driver read the
 * same `details` an HTTP client does, and neither sees response headers.
 */
export class RateLimitedError extends DomainError {
  constructor(
    message: string,
    /** Machine-readable code for the client (under `details.reason`). */
    reason?: string,
    /** How long to wait before retrying, when the limiter told us. */
    retryAfterSeconds?: number,
  ) {
    super('rate_limited', message, {
      ...(reason ? { reason } : {}),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    })
  }
}

/**
 * INTERNAL control-flow signal (NOT a wire/HTTP error): a durable-driver write lost an
 * optimistic-concurrency race — the run row was advanced by a concurrent writer (a human
 * action) or removed/terminated (a `cancel`/`stopRun`) since the driver loaded it, so its
 * `compareAndSwap` refused to land. The driver's entry points ({@link ExecutionService}
 * `advanceInstance` / `RunDispatcher` `pollAgentJob` / `pollGate` / `resolveGatePollExhaustion`)
 * catch this and re-drive on FRESH state (returning `{ kind: 'continue' }`) instead of
 * clobbering the winner with the stale snapshot. Deliberately a plain `Error` (not a
 * {@link DomainError}): it must never reach the HTTP boundary — a leak should fail loudly in
 * tests, not be mapped to a status code.
 */
export class RunContendedError extends Error {
  constructor(executionId: string) {
    super(`Execution '${executionId}' was modified concurrently; re-drive on fresh state`)
    this.name = new.target.name
  }
}

/**
 * A review's own optimistic-concurrency write gave up after its bounded retries — the sibling of
 * {@link RunContendedError} for the iterative-review stores, whose mutations reload and re-apply
 * on the winner's snapshot (`IterativeReviewService.mutateReview`).
 *
 * Unlike `RunContendedError` this IS a {@link ConflictError}, because both kinds of caller are
 * real: an HTTP human action (answer / dismiss / accept a recommendation) wants the 409 and a
 * retry, while the durable driver — which owns the two paths whose mutation carries paid-for LLM
 * output (`incorporate`, `reReview`) — recognises it as a re-drive signal in `advanceInstance` and
 * re-derives on fresh state instead of failing the run and discarding that work. No `reason` code:
 * the SPA has no conflict-specific handling for it beyond "retry", which the message already says.
 */
export class ReviewContendedError extends ConflictError {
  constructor(entityName: string, reviewId: string) {
    super(`${entityName} '${reviewId}' is being modified concurrently; retry`)
    this.name = new.target.name
  }
}

/** Resolve a maybe-null lookup or throw a {@link NotFoundError}. */
export function assertFound<T>(value: T | null | undefined, entity: string, id: string): T {
  if (value === null || value === undefined) throw new NotFoundError(entity, id)
  return value
}

/**
 * Extract a human-readable message from an unknown thrown value: its own message, then each cause
 * beneath it, scrubbed and length-capped (`errorChainText`).
 *
 * The chain is the whole point. This helper feeds the strings a human reads on a connect form, in a
 * provisioning log, on a PR comment and in a persisted failure `reason`, and a transport failure's
 * own message is undici's contentless `fetch failed`, so every one of those surfaces reported an
 * unreachable cluster, an untrusted certificate and a DNS typo with the same three words while the
 * cause sat one `.cause` down. It is the one describer the repo should reach for; a hand-rolled
 * `error instanceof Error ? error.message : String(error)` is that bug re-introduced.
 *
 * WHO MAY READ IT, stated because the chain widens what a message discloses and the answer is not
 * "anyone". This string reaches an AUTHENTICATED reader: a signed-in operator on a connect form,
 * a workspace member whose run failed, a provisioning log, a PR comment on their own repo. That is
 * deliberate, because the inner link is usually the only thing that says whether the fix is theirs
 * (a wrong base URL, an expired key) or the deployment's. The residual is stated rather than
 * implied: where a deployment's model endpoints or infrastructure are platform-internal, their
 * host and port become visible to a workspace member through an ordinary 4xx. An UNAUTHENTICATED
 * surface does not qualify and does not use this: `/ready` on both facades answers with
 * `publicDiagnostic`, the outermost link only.
 *
 * An error with NOTHING to say answers with the empty string, not with `String(error)`. See
 * `errorChainText`: the base constructor name is not a description, and a call site's
 * `getErrorMessage(err) || '<what the operator should do>'` fallback has to stay reachable.
 */
export function getErrorMessage(error: unknown): string {
  return errorChainText(error)
}

/**
 * Extract a {@link DomainError}'s machine-readable `reason` code (under `details.reason`) from an
 * unknown thrown value, else undefined — the read-side dual of the `reason` a `ConflictError` /
 * `ValidationError` carries, so an engine catch can propagate it (onto a run's `AgentFailure.reason`)
 * without string-matching the message.
 */
export function getErrorReason(error: unknown): string | undefined {
  if (error instanceof DomainError && typeof error.details?.reason === 'string') {
    return error.details.reason
  }
  return undefined
}
