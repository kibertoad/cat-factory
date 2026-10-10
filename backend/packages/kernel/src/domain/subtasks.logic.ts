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

/**
 * Parse the JSON-encoded subtask-counts column persisted by the container flows
 * (execution + bootstrap), tolerating a null/garbage value. Shared by both
 * facades' repositories so the lenient row→domain coercion lives in one place.
 */
export function parseSubtasks(raw: string | null): StepSubtasks | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof o.completed === 'number' &&
      typeof o.inProgress === 'number' &&
      typeof o.total === 'number'
    ) {
      return {
        completed: o.completed,
        inProgress: o.inProgress,
        total: o.total,
        items: parseSubtaskItems(o.items),
      }
    }
  } catch {
    // fall through to null on any malformed JSON
  }
  return null
}

/** Coerce the optional todo-item list, dropping any entry missing a label or valid status. */
function parseSubtaskItems(raw: unknown): StepSubtasks['items'] {
  if (!Array.isArray(raw)) return undefined
  const items: NonNullable<StepSubtasks['items']> = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    const status = r.status
    if (
      typeof r.label === 'string' &&
      (status === 'pending' || status === 'in_progress' || status === 'completed')
    ) {
      items.push({ label: r.label, status })
    }
  }
  return items
}
