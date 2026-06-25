import type {
  Clock,
  IdGenerator,
  Notification,
  NotificationChannel,
  NotificationRepository,
  RaiseNotificationInput,
  ResolveNotificationAction,
} from '@cat-factory/kernel'
import { assertFound, requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'

export interface NotificationServiceDependencies {
  notificationRepository: NotificationRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * How humans are told. Defaults to in-app delivery (the `notification`
   * WorkspaceEvent) wired by the worker; email / Slack channels compose in via
   * {@link CompositeNotificationChannel} with no change here. Optional so tests
   * can omit it (the repository remains the canonical store either way).
   */
  channel?: NotificationChannel
}

/**
 * Owns the lifecycle of human-actionable notifications: the canonical D1-backed
 * store (so the inbox + snapshot can render them) plus delivery to the configured
 * channel(s). The *action* a notification triggers (merge a PR, confirm a
 * pipeline, retry a run) is performed by the worker's controller; this service
 * only raises, lists and resolves — keeping it free of execution/GitHub concerns.
 */
export class NotificationService {
  private readonly notifications: NotificationRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly channel?: NotificationChannel

  constructor(deps: NotificationServiceDependencies) {
    this.notifications = deps.notificationRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.channel = deps.channel
  }

  /**
   * Raise (or refresh) a notification. To avoid stacking identical cards when a
   * run is re-driven, an existing OPEN notification of the same `type` on the same
   * block is replaced in place (its id is reused) rather than duplicated.
   */
  async raise(workspaceId: string, input: RaiseNotificationInput): Promise<Notification> {
    const existing = input.blockId
      ? await this.notifications.findOpenByBlock(workspaceId, input.blockId, input.type)
      : null
    const now = this.clock.now()
    const notification: Notification = {
      id: existing?.id ?? this.idGenerator.next('ntf'),
      type: input.type,
      status: 'open',
      // Preserve an already-escalated severity across a re-raise (createdAt is preserved
      // too, so the card keeps its "overdue" red rather than resetting to yellow).
      severity: existing?.severity ?? 'normal',
      blockId: input.blockId,
      executionId: input.executionId,
      title: input.title,
      body: input.body,
      payload: input.payload ?? null,
      createdAt: existing?.createdAt ?? now,
      resolvedAt: null,
    }
    await this.notifications.upsert(workspaceId, notification)
    await this.deliver(workspaceId, notification)
    return notification
  }

  /** Resolve a notification (the human acted on it or dismissed it). Idempotent. */
  async resolve(
    workspaceId: string,
    id: string,
    action: ResolveNotificationAction,
  ): Promise<Notification> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = assertFound(await this.notifications.get(workspaceId, id), 'Notification', id)
    if (existing.status !== 'open') return existing
    const resolved: Notification = {
      ...existing,
      status: action === 'act' ? 'acted' : 'dismissed',
      resolvedAt: this.clock.now(),
    }
    await this.notifications.upsert(workspaceId, resolved)
    await this.deliver(workspaceId, resolved)
    return resolved
  }

  /** All open notifications for the workspace (for the inbox + snapshot). */
  async listOpen(workspaceId: string): Promise<Notification[]> {
    return this.notifications.listOpen(workspaceId)
  }

  /**
   * Resolve the auto-raised "waiting for a human decision" card on a block once its run
   * has advanced past the decision (the human responded, or it auto-passed). Only the
   * `decision_required` type is dismissed — the human-actionable cards a stopped run
   * leaves behind (`merge_review`, `pipeline_complete`, `requirement_review`, …) are
   * resolved by the human acting on them, not here. Without this the card would linger
   * open and the escalation sweep would later flip it red ("Overdue") for a decision that
   * was already made. Idempotent + best-effort: a no-op when no such card is open.
   */
  async clearWaitingDecision(workspaceId: string, blockId: string): Promise<void> {
    const existing = await this.notifications.findOpenByBlock(
      workspaceId,
      blockId,
      'decision_required',
    )
    if (!existing) return
    const resolved: Notification = {
      ...existing,
      status: 'dismissed',
      resolvedAt: this.clock.now(),
    }
    await this.notifications.upsert(workspaceId, resolved)
    await this.deliver(workspaceId, resolved)
  }

  /**
   * Escalate long-waiting open notifications from `normal` (yellow) to `urgent` (red).
   * Called by the periodic sweep with the workspace's `waitingEscalationMinutes`
   * threshold (as ms). Any open notification older than `thresholdMs` that is still
   * `normal` is flipped to `urgent`, persisted, and re-delivered so the inbox re-renders
   * it red in real time. This is the signal that replaced the old hard decision timeout:
   * runs wait indefinitely, the notification colour conveys that a human is overdue.
   * Returns the number escalated.
   */
  async escalateStale(workspaceId: string, thresholdMs: number, now: number): Promise<number> {
    const open = await this.notifications.listOpen(workspaceId)
    let escalated = 0
    for (const n of open) {
      if ((n.severity ?? 'normal') !== 'normal') continue
      if (now - n.createdAt < thresholdMs) continue
      const updated: Notification = { ...n, severity: 'urgent' }
      await this.notifications.upsert(workspaceId, updated)
      await this.deliver(workspaceId, updated)
      escalated++
    }
    return escalated
  }

  /** A single notification by id, or null. */
  async get(workspaceId: string, id: string): Promise<Notification | null> {
    return this.notifications.get(workspaceId, id)
  }

  /** Best-effort delivery to the channel — a failure must never break the caller. */
  private async deliver(workspaceId: string, notification: Notification): Promise<void> {
    if (!this.channel) return
    try {
      await this.channel.deliver(workspaceId, notification)
    } catch {
      // The row is persisted; delivery is an optimisation. Swallow channel errors.
    }
  }
}
