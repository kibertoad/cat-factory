import * as v from 'valibot'
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

/**
 * A persisted row violated its own contract (an unknown enum value, malformed JSON, a
 * column that should never be null). A plain `Error` (not a {@link DomainError}) so the
 * HTTP error handler maps it to a logged 500 — this is internal data corruption, never a
 * client input fault.
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
  logger.error(ctx, 'persistence: stored value is not a valid enum member')
  throw new DataIntegrityError(
    `Invalid stored value '${preview(value)}' for ${String(context.column ?? context.field ?? 'enum')}`,
    ctx,
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
  logger.warn(
    { ...context, value: preview(value), fallback },
    'persistence: unknown enum value, falling back',
  )
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
    logger.error({ ...ctx, err }, 'persistence: stored JSON failed to parse')
    throw new DataIntegrityError(
      `Malformed JSON for ${String(context.column ?? context.field ?? 'column')}`,
      ctx,
    )
  }
  const result = v.safeParse(schema, parsed)
  if (result.success) return result.output
  const ctx = { ...context, raw: preview(raw) }
  logger.error(
    { ...ctx, issues: result.issues.map((i) => i.message) },
    'persistence: stored JSON does not match its contract',
  )
  throw new DataIntegrityError(
    `Stored JSON for ${String(context.column ?? context.field ?? 'column')} violates its contract`,
    ctx,
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
    if (err instanceof DataIntegrityError) {
      logger.error({ ...context, ...err.context }, 'persistence: dropping corrupt row from list')
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
