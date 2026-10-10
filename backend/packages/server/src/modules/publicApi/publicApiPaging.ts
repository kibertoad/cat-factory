import {
  type ExecutionInstance,
  type ExecutionStatus,
  executionStatusSchema,
  type PublicJobStatus,
} from '@cat-factory/contracts'

// Keyset pagination for the public `/api/v1` list endpoints.
//
// Every bounded list on this surface pages the same way: order by a stable sort key, hand the
// caller an OPAQUE cursor pointing at the last row it saw, and resume strictly AFTER that row.
// Keyset rather than offset because an external integration polls: an offset page shifts under
// concurrent inserts, so a row created between two pages either repeats or — worse — is skipped
// and never seen again. A keyset cursor is anchored to a row, so it cannot drift.
//
// The cursor is base64url of `<sortKey>|<id>` and is deliberately UNDOCUMENTED on the wire (the
// contract types it as an opaque string): encoding it means the shape can change without a
// contract break, and a caller that tries to synthesize one gets a clean 400 instead of a
// silently wrong page. It is NOT signed — it carries no authority, only a position, and every
// route re-applies its full workspace + resource-class scope to the query regardless of what the
// cursor says. A tampered cursor can therefore only mis-page the caller's OWN result set.

/** A decoded keyset position: the row's sort key plus its id (the tiebreaker). */
export type PublicCursor = { sortKey: string; id: string }

/** Encode a keyset position into the opaque wire cursor. */
export function encodeCursor(sortKey: string | number, id: string): string {
  return base64UrlEncode(`${sortKey}|${id}`)
}

/**
 * Decode an opaque wire cursor, or null when it is malformed. Callers turn a null into a 400
 * rather than silently serving page 1 — a client that pages on a corrupted cursor would
 * otherwise loop over the first page forever without ever seeing an error.
 */
export function decodeCursor(cursor: string): PublicCursor | null {
  let decoded: string
  try {
    decoded = base64UrlDecode(cursor)
  } catch {
    return null
  }
  // The id may itself contain no `|` (ids are `<prefix>_<hex>`), so split on the FIRST separator
  // and take the rest verbatim — robust even if an id shape ever gains one.
  const sep = decoded.indexOf('|')
  if (sep <= 0) return null
  const sortKey = decoded.slice(0, sep)
  const id = decoded.slice(sep + 1)
  if (!id) return null
  return { sortKey, id }
}

/**
 * Decode a cursor whose sort key is a numeric (epoch-ms) stamp; null when malformed. The sort key
 * must be plain digits — `Number()` alone would happily read `' '` as 0, `'1e3'` as 1000 and
 * `'0x10'` as 16, turning a corrupt cursor into a plausible-looking position instead of the 400
 * the caller needs.
 */
export function decodeTimeCursor(cursor: string): { createdAt: number; id: string } | null {
  const parsed = decodeCursor(cursor)
  if (!parsed || !/^\d+$/.test(parsed.sortKey)) return null
  const createdAt = Number(parsed.sortKey)
  if (!Number.isSafeInteger(createdAt)) return null
  return { createdAt, id: parsed.id }
}

/**
 * Project an internal execution status onto the COARSE status an external caller sees: everything
 * that is neither finished nor failed reads as `running` (a parked `blocked` run and a spend-gated
 * `paused` one are both "still going" from outside).
 */
export function mapStatus(status: ExecutionStatus): PublicJobStatus {
  return status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : 'running'
}

/**
 * Expand the coarse public status a caller filters on into the internal statuses it maps from, so
 * the filter agrees with the `status` each returned job actually carries — filtering on the
 * literal `running` row value would hide exactly the parked/spend-gated jobs a caller polls for.
 *
 * DERIVED from {@link mapStatus} over the full `ExecutionStatus` union rather than hand-listed, so
 * a new member cannot silently fall out of the filter: whatever `mapStatus` says a status reads as
 * externally is what this admits, by construction.
 */
export function internalStatusesFor(status: PublicJobStatus): ExecutionStatus[] {
  return executionStatusSchema.options.filter((internal) => mapStatus(internal) === status)
}

/**
 * The chronological sort key of a run — the ONE definition shared by the `createdAt` a job
 * resource reports and the keyset cursor the list mints, so the two can never drift apart (a
 * cursor naming anything other than the value the query orders by silently skips rows).
 *
 * A persisted run always carries it: the mapper projects `agent_runs.created_at` onto the entity.
 */
export function jobSortKey(execution: ExecutionInstance): number {
  return execution.createdAt ?? 0
}

function base64UrlEncode(value: string): string {
  // btoa is byte-oriented; encode to UTF-8 first so a non-ASCII id can never corrupt the cursor.
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
