import type {
  Notification,
  ReviewDebtItem,
  ReviewFrictionVerdict,
  WorkspaceSettings,
} from '@cat-factory/contracts'
import { assessReviewFriction } from '@cat-factory/contracts'
import type { Block, Clock } from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'

/** Minimal read seam over workspace settings for the review-debt friction guard. */
export interface ReviewFrictionSettingsReader {
  get(workspaceId: string): Promise<WorkspaceSettings>
}

/** Minimal read seam over open notifications for the review-debt friction guard. */
export interface ReviewFrictionNotificationReader {
  listOpen(workspaceId: string): Promise<Notification[]>
}

export interface ReviewFrictionGuardDeps {
  clock: Clock
  /** When BOTH readers are wired and friction is enabled the guard enforces; else pass-through. */
  settings?: ReviewFrictionSettingsReader
  notifications?: ReviewFrictionNotificationReader
}

/**
 * The opt-in review-debt friction guard for task creation (`backend/docs/review-debt-friction.md`),
 * extracted from {@link BoardService} as a cohesive collaborator so the god-file stays under budget.
 * With both seams wired and the workspace's friction enabled, it reads settings + open notifications
 * and computes the shared verdict (the SAME pure function the SPA pre-warns with). Absent seams (or
 * friction off) make it a pass-through, so creation behaves exactly as before.
 */
export class ReviewFrictionGuard {
  private readonly clock: Clock
  private readonly settings?: ReviewFrictionSettingsReader
  private readonly notifications?: ReviewFrictionNotificationReader

  constructor({ clock, settings, notifications }: ReviewFrictionGuardDeps) {
    this.clock = clock
    this.settings = settings
    this.notifications = notifications
  }

  /**
   * Enforce the policy before a human authors a new task. A hard `block` verdict throws a
   * `review_debt_blocked` 409 — an acknowledgement can NEVER tunnel through it, since hard is
   * checked first and ignores the flag. A soft `warn` throws `review_debt_warn` UNLESS the caller
   * acknowledged. `ok` — or unwired seams / friction off — returns silently.
   */
  async assertAllows(
    workspaceId: string,
    blocks: readonly Block[],
    acknowledged: boolean,
  ): Promise<void> {
    const settingsReader = this.settings
    const notificationsReader = this.notifications
    if (!settingsReader || !notificationsReader) return
    const settings = await settingsReader.get(workspaceId)
    if (settings.reviewFrictionMode === 'off') return
    const open = await notificationsReader.listOpen(workspaceId)
    const now = this.clock.now()
    const verdict = assessReviewFriction(open, settings, now)
    if (verdict.kind === 'ok') return
    if (verdict.kind === 'warn' && acknowledged) return
    throw this.conflict(verdict, blocks, settings, now)
  }

  /**
   * Build the 409 for a non-`ok` friction verdict: a machine-readable reason
   * (`review_debt_warn` / `review_debt_blocked`) plus a details payload the SPA renders into the
   * friction dialog — each waiting task's title + how long it has waited (worst first), and the
   * threshold that fired. Titles are joined in from the already-loaded workspace block list, so
   * there is no extra query.
   */
  private conflict(
    verdict: Extract<ReviewFrictionVerdict, { kind: 'warn' | 'block' }>,
    blocks: readonly Block[],
    settings: WorkspaceSettings,
    now: number,
  ): ConflictError {
    const titles = new Map(blocks.map((b) => [b.id, b.title]))
    const debt = verdict.debt.map((item: ReviewDebtItem) => ({
      blockId: item.blockId,
      title: titles.get(item.blockId) ?? null,
      waitingMinutes: Math.max(0, Math.round((now - item.waitingSince) / 60_000)),
    }))
    if (verdict.kind === 'block') {
      const threshold =
        verdict.reason === 'stuck'
          ? settings.reviewFrictionBlockStuckMinutes
          : settings.reviewFrictionBlockCount
      const message =
        verdict.reason === 'stuck'
          ? `Task creation is blocked: a task has been waiting on human review longer than ${threshold} minute(s). Work down the review queue first.`
          : `Task creation is blocked: ${debt.length} task(s) are waiting on human review (limit ${threshold}). Work down the review queue first.`
      return new ConflictError(message, 'review_debt_blocked', {
        friction: verdict.reason,
        debt,
        threshold,
      })
    }
    return new ConflictError(
      `${debt.length} task(s) are waiting on human review. Consider reviewing them before creating more work.`,
      'review_debt_warn',
      { debt, threshold: settings.reviewFrictionWarnCount },
    )
  }
}
