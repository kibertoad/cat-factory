// The persistence-boundary integrity error, and the predicate for recognising one.
//
// It lives in kernel rather than beside the row mappers that throw it (`@cat-factory/server`'s
// `persistence/decode.ts`) because the ENGINE has to be able to recognise it: a run row that
// cannot be decoded is the one failure a driver must dispose of instead of retrying, and
// orchestration cannot see the server package. Recognising it by TYPE is the whole point: the
// alternative, treating any throw from a repository read as unrecoverable, would fail live runs
// on a transient database blip.

/**
 * WHY the row could not be read, and the only thing that decides whether the reader may DISPOSE
 * of it (write it terminal) or must leave it alone:
 *
 *   - `malformed` — the row's shape is wrong for ANY reader: a column that must never be null,
 *     JSON that does not parse, a cursor outside the list it indexes. No build, past or future,
 *     can make sense of it, so the reader that hits it is the last one that ever will.
 *   - `unrecognized_value` — a stored value is not a member of a vocabulary THIS BUILD knows.
 *     That is a fact about the READER, not about the row: a value a NEWER build writes reads
 *     exactly like a corrupt one to an older replica, and a rolling deploy runs both at once.
 *     Disposal is irreversible and the retry is free, so this class is never disposed of.
 *
 * The asymmetry is the point. Guessing `malformed` on a value from the future destroys a healthy
 * run; guessing `unrecognized_value` on a genuinely corrupt row costs re-drives that are counted
 * (`sweep.run_recovery_failed`) and settled by the hard-stall backstop.
 */
export type DataIntegrityFault = 'malformed' | 'unrecognized_value'

/** Every {@link DataIntegrityFault}, for a wire decode that must reject an unknown value. */
const DATA_INTEGRITY_FAULTS: readonly DataIntegrityFault[] = ['malformed', 'unrecognized_value']

/**
 * Whether `value` is a {@link DataIntegrityFault} this build knows. Derived from the vocabulary
 * itself, so adding a member cannot leave this behind.
 */
export function isDataIntegrityFault(value: unknown): value is DataIntegrityFault {
  return typeof value === 'string' && (DATA_INTEGRITY_FAULTS as readonly string[]).includes(value)
}

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
    /** See {@link DataIntegrityFault}: which readers can never read this row, and which merely cannot. */
    readonly fault: DataIntegrityFault,
  ) {
    super(message)
    this.name = 'DataIntegrityError'
  }
}

/**
 * A thrown value RECOGNISED as a {@link DataIntegrityError}, which is a weaker claim than being
 * one. `context` is optional and `fault` widens to `undefined` because the `name` fallback below
 * cannot check either: what it promises is exactly what it verified. A caller that needs the
 * fault reads it through {@link dataIntegrityFaultOf}, which supplies the safe answer.
 */
export type RecognisedDataIntegrityError = Error & {
  readonly context?: Record<string, unknown>
  readonly fault?: DataIntegrityFault
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
export function isDataIntegrityError(error: unknown): error is RecognisedDataIntegrityError {
  return (
    error instanceof DataIntegrityError ||
    (error instanceof Error && error.name === 'DataIntegrityError')
  )
}

/**
 * The {@link DataIntegrityFault} of a recognised integrity error, or `unrecognized_value` when it
 * carries none.
 *
 * The fallback is the SAFE half of the vocabulary rather than the common one. A missing fault means
 * the error crossed a boundary that dropped it, or came from a build whose vocabulary this one does
 * not share, and in both cases the reader knows less than the thrower did. Answering `malformed`
 * there would let exactly the uncertainty this classification exists to respect destroy a run.
 */
export function dataIntegrityFaultOf(error: RecognisedDataIntegrityError): DataIntegrityFault {
  return isDataIntegrityFault(error.fault) ? error.fault : 'unrecognized_value'
}
