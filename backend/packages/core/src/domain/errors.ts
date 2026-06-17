// Domain-level errors. The core throws these; the facade's error handler maps
// them to HTTP status codes. Keeping them framework-agnostic means the same core
// can be wrapped by a different transport (queue consumer, RPC, CLI) unchanged.

export type DomainErrorCode = 'not_found' | 'validation' | 'conflict'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
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

/** Conflicts with current state (→ 409). */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super('conflict', message)
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
