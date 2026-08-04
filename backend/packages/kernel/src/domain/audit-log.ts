import type { AuditActor } from '../ports/audit.js'

// ---------------------------------------------------------------------------
// The audit log's pure rules: how a page is bounded, how a cursor names the row it continues
// from, and how persisted actor columns read back as a principal.
//
// In kernel rather than in either facade because BOTH implement `AuditEventRepository` and must
// agree byte-for-byte about all three. A cursor is opaque to its caller, which is exactly why a
// per-facade copy of its encoding is dangerous: nothing about a mismatched cursor looks wrong at
// the boundary, it just silently starts a page somewhere else. The conformance suite drives both
// repositories through the same pagination assertions, so a divergence would have to be a
// divergence in code they share.
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
 * Shaped structurally (a plain snake_case object) rather than against either driver's row type,
 * so both facades map through this one function. Anything that is not a complete `user` or
 * `apiKey` principal reads as `system`: that is the honest rendering of "no principal is
 * recorded on this row", and it never invents a user id, which is the single outcome that would
 * misattribute an action to a person.
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
