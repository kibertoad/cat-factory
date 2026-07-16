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
 * pipeline, retry a run) is performed by a caller-supplied side effect at the
 * controller; this service raises, lists, acts (atomically claiming the card
 * before that side effect runs — see {@link act}), resolves and escalates —
 * keeping it free of execution/GitHub concerns.
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
   *
   * Delivery to the channel only fires on a NEW card or one whose user-visible content
   * (title/body/severity/status/payload) actually CHANGED. An indefinitely-polling gate
   * (e.g. `human-review`) re-raises the same card every poll; re-pushing an unchanged card
   * each time would flicker/re-toast the inbox for the whole wait, so an identical re-raise
   * is persisted (it keeps `updatedAt` fresh) but NOT re-delivered.
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
    // Block-scoped cards persist through the atomic open-dedup write (a partial unique
    // index collapses a concurrent double-raise to one open row); block-less cards keep
    // the plain id-keyed upsert. Either way the read above still drives id reuse,
    // severity/createdAt preservation and the deliver-or-not decision below.
    //
    // The block-scoped write returns the CANONICAL persisted row: when a concurrent raise
    // won the insert, our optimistic id was discarded in favour of the existing card's id,
    // so we must deliver and return THAT row — delivering our in-memory copy would push a
    // phantom-id card the inbox can't resolve (404 on action) and leak the dedup back.
    let persisted = notification
    if (input.blockId) {
      persisted = await this.notifications.upsertOpenForBlock(workspaceId, notification)
    } else {
      await this.notifications.upsert(workspaceId, notification)
    }
    if (!existing || this.contentChanged(existing, notification)) {
      await this.deliver(workspaceId, persisted)
    }
    return persisted
  }

  /** Whether a re-raised notification's user-visible content differs from the open one. */
  private contentChanged(prev: Notification, next: Notification): boolean {
    return (
      prev.title !== next.title ||
      prev.body !== next.body ||
      prev.severity !== next.severity ||
      prev.status !== next.status ||
      // The execution the card deep-links to: a block retried under a NEW run can re-raise a
      // content-identical card (same title/body/payload) pointing at a different executionId.
      // The client acts/reveals via `executionId`, so a changed one must be re-delivered or the
      // inbox keeps targeting the stale (terminal) run.
      prev.executionId !== next.executionId ||
      JSON.stringify(prev.payload ?? null) !== JSON.stringify(next.payload ?? null)
    )
  }

  /**
   * Act on a notification EXACTLY ONCE under concurrency: atomically claim the OPEN card
   * (`open` → `acted`) BEFORE running its `sideEffect` (merge the PR / retry the run), so two
   * concurrent acts — a double-click, two members' inboxes, an HTTP retry — can't both fire
   * the side effect. The winner of the atomic flip runs it; a loser (or an already-resolved
   * card) returns the settled row untouched. The side effect lives at the call site (the
   * controller) so this service stays free of execution/GitHub concerns.
   *
   * If the side effect throws, the card is reverted to `open` (and re-delivered) so the human
   * can retry, then the error propagates — preserving the pre-fix "failed action stays
   * retryable" behaviour without the double-fire window it had.
   */
  async act(
    workspaceId: string,
    id: string,
    sideEffect: (notification: Notification) => Promise<void>,
  ): Promise<Notification> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = assertFound(await this.notifications.get(workspaceId, id), 'Notification', id)
    // Fast path: an already-resolved card is a no-op (idempotent), skipping the claim entirely.
    if (existing.status !== 'open') return existing

    const claimed = await this.notifications.claimForAction(workspaceId, id, this.clock.now())
    if (!claimed) {
      // A concurrent act won the flip between our read and the claim — it owns the side effect.
      // Return the now-settled row rather than acting again.
      return assertFound(await this.notifications.get(workspaceId, id), 'Notification', id)
    }

    try {
      await sideEffect(claimed)
    } catch (err) {
      // The action failed; reopen the card so the human can retry, then surface the error. The
      // card is `acted` (not `open`) during the side effect, so the escalation sweep can't touch
      // it and this revert can't lose an escalation.
      const reopened: Notification = { ...claimed, status: 'open', resolvedAt: null }
      await this.notifications.upsert(workspaceId, reopened)
      await this.deliver(workspaceId, reopened)
      throw err
    }
    await this.deliver(workspaceId, claimed)
    return claimed
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
   * Resolve the auto-raised "waiting for a human decision" cards on a block once its run
   * has advanced past the gate (the human responded, or it auto-passed). Dismisses the
   * gate-driven cards the run clears for itself — the generic `decision_required` card and
   * the Follow-up companion's `followup_pending` card — but NOT the human-actionable cards a
   * stopped run leaves behind (`merge_review`, `pipeline_complete`, `requirement_review`, …),
   * which the human resolves by acting on them. Without this the card would linger open and
   * the escalation sweep would later flip it red ("Overdue") for a decision already made.
   * Idempotent + best-effort: a no-op when no such card is open.
   */
  async clearWaitingDecision(workspaceId: string, blockId: string): Promise<void> {
    for (const type of [
      'decision_required',
      'followup_pending',
      'fork_decision_pending',
      'pr_review_ready',
    ] as const) {
      const existing = await this.notifications.findOpenByBlock(workspaceId, blockId, type)
      if (!existing) continue
      const resolved: Notification = {
        ...existing,
        status: 'dismissed',
        resolvedAt: this.clock.now(),
      }
      await this.notifications.upsert(workspaceId, resolved)
      await this.deliver(workspaceId, resolved)
    }
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
    // One SQL statement flips every overdue card (no load-filter-upsert loop); each
    // escalated row is then re-delivered so the inbox re-renders it red in real time.
    const escalated = await this.notifications.escalateStaleOpen(workspaceId, now - thresholdMs)
    for (const n of escalated) {
      await this.deliver(workspaceId, n)
    }
    return escalated.length
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
