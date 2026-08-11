// The persistence-boundary integrity error, and the predicate for recognising one.
//
// It lives in kernel rather than beside the row mappers that throw it (`@cat-factory/server`'s
// `persistence/decode.ts`) because the ENGINE has to be able to recognise it: a run row that
// cannot be decoded is the one failure a driver must dispose of instead of retrying, and
// orchestration cannot see the server package. Recognising it by TYPE is the whole point: the
// alternative, treating any throw from a repository read as unrecoverable, would fail live runs
// on a transient database blip.

/**
 * A persisted row violated its own contract (an unknown enum value, malformed JSON, a column
 * that should never be null), or a row about to be WRITTEN would. A plain `Error` (not a
 * `DomainError`) so the HTTP error handler maps it to a logged 500: this is internal data
 * corruption, never a client input fault.
 */
export class DataIntegrityError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DataIntegrityError'
  }
}

/**
 * Whether a thrown value is a {@link DataIntegrityError}, i.e. whether the state it names is
 * UNREADABLE rather than momentarily unavailable. Callers branch on this to dispose of a poison
 * row (write it terminal) instead of re-driving it forever.
 *
 * The `name` fallback is deliberate: a facade can end up with two copies of a package in its
 * dependency tree, and `instanceof` across copies is false while the class is the same class.
 * Getting that wrong here would resurrect the exact loop this predicate exists to break.
 */
export function isDataIntegrityError(error: unknown): error is DataIntegrityError {
  return (
    error instanceof DataIntegrityError ||
    (error instanceof Error && error.name === 'DataIntegrityError')
  )
}
