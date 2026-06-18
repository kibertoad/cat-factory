import type {
  Clock,
  IdGenerator,
  Notification,
  NotificationChannel,
  NotificationPayload,
  NotificationRepository,
  NotificationType,
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

/** What a caller (the execution engine) supplies to raise a notification. */
export interface RaiseNotificationInput {
  type: NotificationType
  blockId: string | null
  executionId: string | null
  title: string
  body: string
  payload?: NotificationPayload | null
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
