import type { TaskTypeFields } from '~/types/domain'

// The pure half of TaskReviewTarget: what an edit of the review-skill queue SENDS. Extracted for
// the reason every `*.logic.ts` here is (a decision worth a test should not need a mounted
// component to reach), and this one carries a rule the shape of the request makes easy to get
// wrong in exactly one direction.

/**
 * The `builtinTaskTypeFields` payload that stores `queue` as this task's review-skill queue.
 *
 * The built-in half is replaced WHOLE by the write (`replaceBuiltinHalf`), so every other built-in
 * key has to be carried or editing the queue would clear the pull request the task reviews. The
 * `custom` half travels under its own request key and is dropped here by construction.
 *
 * The stored queue is dropped from that carry-through FIRST, and that is the whole point: an
 * EMPTY queue is expressed by the key being absent, so spreading the stored bag and then adding
 * the key back only when non-empty would carry the old ids on the one edit that most needs to
 * land. Removing the last queued skill is how a task wedged by a skill that left the catalog gets
 * un-wedged, so it is precisely the case that must not silently no-op.
 */
export function reviewSkillQueuePatch(
  stored: TaskTypeFields | null | undefined,
  queue: readonly string[],
): TaskTypeFields {
  const { custom: _custom, reviewSkillIds: _stored, ...builtin } = stored ?? {}
  return { ...builtin, ...(queue.length ? { reviewSkillIds: [...queue] } : {}) }
}

/** Whether the edit buffer differs from the stored queue, ORDER included (the queue is ordered). */
export function reviewQueueDirty(stored: readonly string[], draft: readonly string[]): boolean {
  return stored.length !== draft.length || stored.some((id, i) => draft[i] !== id)
}
