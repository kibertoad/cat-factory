// Domain-level errors. The core throws these; the facade's error handler maps
// them to HTTP status codes. Keeping them framework-agnostic means the same core
// can be wrapped by a different transport (queue consumer, RPC, CLI) unchanged.

export type DomainErrorCode = 'not_found' | 'validation' | 'conflict' | 'credential_required'

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
  constructor(entity: string, id: string) {
    super('not_found', `${entity} '${id}' not found`)
  }
}

/** Structurally valid but violates a domain rule (→ 422). */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('validation', message)
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

/** Resolve a maybe-null lookup or throw a {@link NotFoundError}. */
export function assertFound<T>(value: T | null | undefined, entity: string, id: string): T {
  if (value === null || value === undefined) throw new NotFoundError(entity, id)
  return value
}

/** Extract a human-readable message from an unknown thrown value. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
