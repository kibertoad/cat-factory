import * as v from 'valibot'
import { DataIntegrityError, describeError, isDataIntegrityError } from '@cat-factory/kernel'
import { logger } from '../observability/logger.js'

// Validate-on-read guards for the persistence boundary.
//
// Stored enum/discriminator columns and JSON blobs are otherwise re-hydrated with a bare
// `as SomeType` cast — a compile-time fiction that is erased at runtime, so a corrupt or
// out-of-contract value flows into the domain as a *fake-valid* value and only misbehaves
// far from its origin. These helpers re-assert the Valibot wire contract (the actual source
// of truth) at the moment a row is read, so an invalid value surfaces early, loudly, and
// with enough context (table/column/id/value) to find the offending row.
//
// Two policies:
//   - throw  (`decodeEnum` / `decodeJson`)  — for engine-critical fields where a wrong value
//     corrupts execution (vendor, block status/level, execution status, run kind). A throw
//     becomes a logged 500 via the HTTP error handler — the loudest, most visible signal.
//   - degrade (`decodeEnumOr` / `tryDecodeRow`) — for snapshot-facing reads where one bad
//     row must not down a whole board load: log loudly + fall back / drop the single row.

// The error these guards throw lives in kernel (`domain/data-integrity.ts`) and is re-exported
// here, where every thrower and most catchers already look for it. It has to be visible to the
// ENGINE as well as to this boundary: a run row that cannot be decoded is disposed of by the
// execution service rather than re-driven forever, and orchestration cannot import this package.
export { DataIntegrityError, isDataIntegrityError } from '@cat-factory/kernel'

// Each throw below also states its `DataIntegrityFault`, which is what decides whether a reader
// may DISPOSE of the row. The split runs along this file's own seam: a value that is not a member
// of a picklist is `unrecognized_value` (this build's vocabulary may simply be older than the
// writer's), while JSON that does not parse is `malformed` (no build can read it).

/** Truncate a stored value for safe inclusion in a log/error message. */
function preview(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s != null && s.length > 120 ? `${s.slice(0, 120)}…` : String(s)
}

/**
 * Validate a stored scalar against its Valibot picklist/contract and return the typed
 * value, or throw a {@link DataIntegrityError} (logged) when it is not a known member.
 * Use for engine-critical enums where a wrong value must stop the request, not degrade.
 */
export function decodeEnum<T>(
  schema: v.GenericSchema<unknown, T>,
  value: unknown,
  context: Record<string, unknown>,
): T {
  const result = v.safeParse(schema, value)
  if (result.success) return result.output
  const ctx = { ...context, value: preview(value) }
  logger.error('persistence: stored value is not a valid enum member', ctx)
  throw new DataIntegrityError(
    `Invalid stored value '${preview(value)}' for ${String(context.column ?? context.field ?? 'enum')}`,
    ctx,
    // Not `malformed`: this build's picklist is the only thing that rejected the value, and a
    // NEWER build's legitimate new member is indistinguishable from corruption from here.
    'unrecognized_value',
  )
}

/**
 * Validate a stored scalar against its contract, returning the typed value or — for a
 * non-member — logging loudly and falling back to `fallback`. Use ONLY for cosmetic,
 * snapshot-facing fields (e.g. notification `severity`) where degrading beats failing.
 */
export function decodeEnumOr<T>(
  schema: v.GenericSchema<unknown, T>,
  value: unknown,
  fallback: T,
  context: Record<string, unknown>,
): T {
  const result = v.safeParse(schema, value)
  if (result.success) return result.output
  logger.warn('persistence: unknown enum value, falling back', {
    ...context,
    value: preview(value),
    fallback,
  })
  return fallback
}

/**
 * `JSON.parse` a stored column then validate the result against its Valibot schema,
 * returning the typed value or throwing a {@link DataIntegrityError} (logged) on either a
 * parse failure or a shape mismatch. Use for engine-critical JSON columns.
 */
export function decodeJson<T>(
  schema: v.GenericSchema<unknown, T>,
  raw: string,
  context: Record<string, unknown>,
): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const ctx = { ...context, raw: preview(raw) }
    // `describeError`, not a bare `err`: the Worker's browser build stringifies a raw `Error`
    // to `{}`, which would erase the parse failure's cause on precisely the corrupt-row path
    // that exists to explain it.
    logger.error('persistence: stored JSON failed to parse', { ...ctx, ...describeError(err) })
    throw new DataIntegrityError(
      `Malformed JSON for ${String(context.column ?? context.field ?? 'column')}`,
      ctx,
      // Unparseable bytes are unparseable for every build there will ever be.
      'malformed',
    )
  }
  const result = v.safeParse(schema, parsed)
  if (result.success) return result.output
  const ctx = { ...context, raw: preview(raw) }
  logger.error('persistence: stored JSON does not match its contract', {
    ...ctx,
    issues: result.issues.map((i) => i.message),
  })
  throw new DataIntegrityError(
    `Stored JSON for ${String(context.column ?? context.field ?? 'column')} violates its contract`,
    ctx,
    // A blob that parses but misses its schema is most often a NESTED unknown member (a new agent
    // kind, a new step field a newer build writes), and this branch cannot tell that from a
    // genuinely garbled shape. Classified as the reversible half for that reason.
    'unrecognized_value',
  )
}

/**
 * Run a row→domain mapping, returning its result or — when the row is corrupt (a
 * {@link DataIntegrityError} bubbles up) — logging loudly and returning `null` so the
 * caller's list loop can drop the single bad row instead of failing the whole read.
 * The "degrade at read" primitive for snapshot-facing `list()` queries.
 */
export function tryDecodeRow<T>(map: () => T, context: Record<string, unknown>): T | null {
  try {
    return map()
  } catch (err) {
    // `isDataIntegrityError`, never `instanceof`: while the class lived in this module, thrower and
    // catcher could not disagree about it; now that it lives in kernel, a facade with two copies of
    // that package in its tree would make `instanceof` false for the very same class and turn one
    // corrupt row back into a failed board load. Same hazard as the engine's disposal check, and
    // the reason the predicate exists at all.
    if (isDataIntegrityError(err)) {
      logger.error('persistence: dropping corrupt row from list', { ...context, ...err.context })
      return null
    }
    throw err
  }
}

/**
 * Map a list of rows to the domain via {@link tryDecodeRow}, dropping (and logging) any row
 * whose mapping raises a {@link DataIntegrityError}. The list-read counterpart to the
 * single-row `map() → throw` policy: a corrupt row must not take down a whole snapshot /
 * board load, so it is dropped rather than failing the entire query. `context(row)` supplies
 * the per-row log context (e.g. `{ table, id }`).
 */
export function tryDecodeRows<R, T>(
  rows: readonly R[],
  map: (row: R) => T,
  context: (row: R) => Record<string, unknown>,
): T[] {
  const out: T[] = []
  for (const row of rows) {
    const decoded = tryDecodeRow(() => map(row), context(row))
    if (decoded !== null) out.push(decoded)
  }
  return out
}
