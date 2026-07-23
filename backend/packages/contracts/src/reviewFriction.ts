import { isReviewWaitNotificationType } from './notifications.js'
import type { Notification } from './notifications.js'
import type { WorkspaceSettings } from './workspace-settings.js'

// ---------------------------------------------------------------------------
// Review-debt friction — the one pure verdict function, shared by the SPA (which
// computes it from the workspace snapshot for progressive pre-warning) and the
// backend enforcement point in `BoardService.addTask` (the authority). Living in
// contracts means the server-side check can never disagree with what the UI showed.
//
// Full design + rationale: `backend/docs/review-debt-friction.md`. This mirrors the
// `frameAllowsVisualPipeline` precedent — a pure predicate colocated with its wire
// types, taking narrow structural inputs so it stays decoupled.
// ---------------------------------------------------------------------------

/** One task currently waiting on human review (a unit of review debt). */
export interface ReviewDebtItem {
  blockId: string
  /** Epoch ms the task first started waiting (min createdAt over its open review-wait cards). */
  waitingSince: number
}

export type ReviewFrictionVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; debt: ReviewDebtItem[] }
  | { kind: 'block'; reason: 'count' | 'stuck'; debt: ReviewDebtItem[] }

type FrictionNotification = Pick<Notification, 'type' | 'status' | 'blockId' | 'createdAt'>

type FrictionSettings = Pick<
  WorkspaceSettings,
  | 'reviewFrictionMode'
  | 'reviewFrictionWarnCount'
  | 'reviewFrictionBlockCount'
  | 'reviewFrictionBlockStuckMinutes'
>

/**
 * Build the deduplicated review-debt list from a workspace's open notifications: one
 * item per `blockId` that holds at least one OPEN notification of a review-wait type,
 * with `waitingSince` = the earliest such card's `createdAt` (when the task first
 * started waiting in its current park). Sorted worst-first (oldest wait first) so a
 * caller can name the actual worst offender. Exported so the frontend can render the
 * same list the verdict is computed from.
 */
export function collectReviewDebt(
  openNotifications: readonly FrictionNotification[],
): ReviewDebtItem[] {
  const byBlock = new Map<string, number>()
  for (const n of openNotifications) {
    if (n.status !== 'open') continue
    if (n.blockId == null) continue
    if (!isReviewWaitNotificationType(n.type)) continue
    const existing = byBlock.get(n.blockId)
    if (existing === undefined || n.createdAt < existing) {
      byBlock.set(n.blockId, n.createdAt)
    }
  }
  return [...byBlock.entries()]
    .map(([blockId, waitingSince]) => ({ blockId, waitingSince }))
    .sort((a, b) => a.waitingSince - b.waitingSince)
}

/**
 * Decide whether authoring a new task should be frictioned given the workspace's open
 * notifications + settings. Precedence: `off` → ok; then (in `enforce`) the age trigger
 * (`stuck`) wins over the count trigger so the error names the actual worst offender;
 * then the count block; then the soft warn tier; else ok.
 */
export function assessReviewFriction(
  openNotifications: readonly FrictionNotification[],
  settings: FrictionSettings,
  now: number,
): ReviewFrictionVerdict {
  if (settings.reviewFrictionMode === 'off') return { kind: 'ok' }

  const debt = collectReviewDebt(openNotifications)

  if (settings.reviewFrictionMode === 'enforce') {
    const stuckMinutes = settings.reviewFrictionBlockStuckMinutes
    if (stuckMinutes != null) {
      const stuckMs = stuckMinutes * 60_000
      if (debt.some((d) => now - d.waitingSince >= stuckMs)) {
        return { kind: 'block', reason: 'stuck', debt }
      }
    }
    const blockCount = settings.reviewFrictionBlockCount
    if (blockCount != null && debt.length >= blockCount) {
      return { kind: 'block', reason: 'count', debt }
    }
  }

  if (debt.length >= settings.reviewFrictionWarnCount) {
    return { kind: 'warn', debt }
  }
  return { kind: 'ok' }
}
