import type { SlackMemberMappingEntry } from '~/types/slack'

// Pure helpers for the Slack member-mapping editor (SlackPanel.vue). Extracted so
// the save-time integrity rules (UX-23) can be unit-tested without mounting the panel.

/**
 * An editable member-map row: the wire entry plus a client-only stable `uid` so a
 * mid-list delete keys the `v-model` by identity, not the array index (index keys
 * silently rebound a neighbour's inputs — UX-23).
 */
export type MemberRow = SlackMemberMappingEntry & { uid: string }

/**
 * True when any row has exactly one of the two ids filled. A half-entered mapping
 * used to be silently dropped on save (UX-23); the panel blocks the save instead so
 * the user doesn't lose it. A fully-empty row is an unused slot, not half-filled.
 */
export function hasHalfFilledRow(
  rows: readonly Pick<MemberRow, 'userId' | 'slackUserId'>[],
): boolean {
  return rows.some((e) => Boolean(e.userId.trim()) !== Boolean(e.slackUserId.trim()))
}

/**
 * The rows to persist: fully-filled only (empty slots dropped), with the client-only
 * `uid` stripped from the wire payload.
 */
export function toMemberEntries(rows: readonly MemberRow[]): SlackMemberMappingEntry[] {
  return rows
    .filter((e) => e.userId.trim() && e.slackUserId.trim())
    .map(({ uid: _uid, ...entry }) => entry)
}

/**
 * Wrap a stored wire entry as an editable row: stamp a stable `uid` and default the
 * `role` (absent on older maps) so the initial load and the post-save reload produce
 * identical rows rather than drifting on the default.
 */
export function toMemberRow(entry: SlackMemberMappingEntry, uid: string): MemberRow {
  return { role: 'engineering', ...entry, uid }
}

/** A fresh, empty editable row stamped with the given stable `uid`. */
export function emptyMemberRow(uid: string): MemberRow {
  return { uid, userId: '', slackUserId: '', role: 'engineering' }
}
