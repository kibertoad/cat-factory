import type { AuditEventDetails } from '@cat-factory/contracts'
import { readAuditAction, readAuditTargetType } from '@cat-factory/contracts'
import type { AuditActor, AuditEventRecord, AuditEventView } from '../ports/audit.js'

// ---------------------------------------------------------------------------
// The audit log's pure rules: how a page is bounded, how a cursor names the row it continues
// from, and how a persisted row reads back as an event.
//
// In kernel rather than in either facade because BOTH implement `AuditEventRepository` and must
// agree byte-for-byte about all of it. A cursor is opaque to its caller, which is exactly why a
// per-facade copy of its encoding is dangerous: nothing about a mismatched cursor looks wrong at
// the boundary, it just silently starts a page somewhere else. The row mapping is here for a
// related reason: it holds three decisions a reader could get subtly wrong on its own (which
// actor column belongs to which kind, what a retired vocabulary member renders as, what an
// unreadable `details` blob does), and a facade that re-derived any of them would diverge in a
// way only that runtime's users would ever see. The conformance suite drives both repositories
// through the same assertions, so a divergence would have to be a divergence in code they share.
// ---------------------------------------------------------------------------

/** Default page size when a caller names none. */
export const AUDIT_PAGE_LIMIT_DEFAULT = 50
/** Hard ceiling, so a caller-supplied `limit` can't ask for the whole table. */
export const AUDIT_PAGE_LIMIT_MAX = 200

/** The (at, id) pair a cursor points just past. */
export interface AuditCursor {
  at: number
  id: string
}

/** Clamp a caller's requested page size into the allowed range. */
export function auditPageLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return AUDIT_PAGE_LIMIT_DEFAULT
  return Math.min(Math.floor(limit), AUDIT_PAGE_LIMIT_MAX)
}

/**
 * Encode the last row of a page as the next page's cursor. `at` and `id` TOGETHER, because `at`
 * alone is not unique: two events recorded in the same millisecond would straddle the boundary
 * and be served twice or skipped.
 */
export function encodeAuditCursor(row: AuditCursor): string {
  return `${row.at}:${row.id}`
}

/**
 * Decode a cursor, or null when there is none / it is unreadable.
 *
 * A malformed cursor reads as "start from the newest" rather than throwing: cursors are opaque
 * and round-trip through a URL, so a truncated one is a client bug that should cost a page
 * position, not a 500. It cannot widen a read either way, because the account scope is a
 * separate argument that no cursor carries.
 */
export function decodeAuditCursor(cursor?: string | null): AuditCursor | null {
  if (!cursor) return null
  const split = cursor.indexOf(':')
  if (split <= 0 || split === cursor.length - 1) return null
  const at = Number(cursor.slice(0, split))
  if (!Number.isSafeInteger(at)) return null
  return { at, id: cursor.slice(split + 1) }
}

/**
 * The persisted actor columns as a discriminated {@link AuditActor}.
 *
 * Anything that is not a complete `user` or `apiKey` principal reads as `system`: that is the
 * honest rendering of "no principal is recorded on this row", and it never invents a user id,
 * which is the single outcome that would misattribute an action to a person.
 */
export function rowToAuditActor(row: {
  actor_kind: string
  actor_user_id: string | null
  actor_api_key_id: string | null
}): AuditActor {
  if (row.actor_kind === 'user' && row.actor_user_id) {
    return { kind: 'user', userId: row.actor_user_id }
  }
  if (row.actor_kind === 'apiKey' && row.actor_api_key_id) {
    return { kind: 'apiKey', apiKeyId: row.actor_api_key_id }
  }
  return { kind: 'system' }
}

/** The two nullable actor columns for a principal, for an INSERT. */
export function auditActorColumns(actor: AuditActor): {
  actor_kind: AuditActor['kind']
  actor_user_id: string | null
  actor_api_key_id: string | null
} {
  return {
    actor_kind: actor.kind,
    actor_user_id: actor.kind === 'user' ? actor.userId : null,
    actor_api_key_id: actor.kind === 'apiKey' ? actor.apiKeyId : null,
  }
}

/** An event's `details` as the single TEXT column both stores keep it in. */
export function encodeAuditDetails(details: AuditEventDetails): string {
  return JSON.stringify(details)
}

/**
 * The `details` column as fields again, or an EMPTY set when the blob is unreadable.
 *
 * Empty rather than a throw, deliberately, and it is the one place in this module where the
 * lenient branch is the strict choice: who acted, on what, and when are the irreplaceable parts
 * of an audit row, and losing the whole row (or the whole PAGE) because one event's values no
 * longer parse is the single failure a viewer must not have. The values are what the viewer
 * interpolates, so their absence shows up as a row that states less, never as a row that is not
 * there. A non-object blob (`"null"`, `"3"`, `"[]"`) counts as unreadable for the same reason it
 * would break interpolation.
 */
export function decodeAuditDetails(raw: string | null): AuditEventDetails {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as AuditEventDetails
  } catch {
    // An unparseable value blob must not cost the row it belongs to, and the empty result is
    // itself the report: the viewer renders the action with no values.
    return {}
  }
}

/** The snake_case columns both stores keep an audit event in, as WRITTEN. */
export interface AuditEventColumns {
  id: string
  account_id: string
  workspace_id: string | null
  actor_kind: string
  actor_user_id: string | null
  actor_api_key_id: string | null
  action: string
  target_type: string
  target_id: string
  details: string
  at: number
}

/**
 * The same row as READ BACK. Identical but for `details`, which the reader tolerates as NULL
 * even though both schemas declare it NOT NULL: a driver, a hand-run statement or a future
 * lineage can still hand one over, and the row is worth more than its values (see
 * {@link decodeAuditDetails}). The WRITE type admits no null, so nothing here can produce one.
 */
export interface AuditEventRow extends Omit<AuditEventColumns, 'details'> {
  details: string | null
}

/** Every column of an audit event, for an INSERT. */
export function auditEventColumns(event: AuditEventRecord): AuditEventColumns {
  return {
    id: event.id,
    account_id: event.accountId,
    workspace_id: event.workspaceId ?? null,
    ...auditActorColumns(event.actor),
    action: event.action,
    target_type: event.targetType,
    target_id: event.targetId,
    details: encodeAuditDetails(event.details),
    at: event.at,
  }
}

/**
 * A persisted row as the event a viewer renders.
 *
 * Shaped structurally (a plain snake_case object) rather than against either driver's row type,
 * so both facades map through this one function. `action` and `target_type` go through the
 * contracts readers, so a member retired since the row was written arrives NAMED as retired
 * rather than dropped or guessed at.
 */
export function rowToAuditEventView(row: AuditEventRow): AuditEventView {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    actor: rowToAuditActor(row),
    action: readAuditAction(row.action),
    targetType: readAuditTargetType(row.target_type),
    targetId: row.target_id,
    details: decodeAuditDetails(row.details),
    at: row.at,
  }
}
