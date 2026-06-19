import type { StepSubtasks } from './types.js'

// Shared subtask-snapshot comparison used by the container-backed flows
// (execution + bootstrap) to skip redundant re-writes and event broadcasts when
// a poll returns the same progress as the last one.

/** Whether two subtask snapshots carry the same counts + items (skips redundant re-emits). */
export function sameSubtasks(a: StepSubtasks | null | undefined, b: StepSubtasks): boolean {
  return (
    a != null &&
    a.completed === b.completed &&
    a.inProgress === b.inProgress &&
    a.total === b.total &&
    sameSubtaskItems(a.items, b.items)
  )
}

/** Whether two todo-item lists carry the same labels + statuses, in order. */
export function sameSubtaskItems(a: StepSubtasks['items'], b: StepSubtasks['items']): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((it, i) => it.label === b[i]?.label && it.status === b[i]?.status)
}
