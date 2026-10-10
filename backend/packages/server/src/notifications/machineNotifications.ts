import type {
  Notification,
  NotificationChannel,
  NotificationDeliveryReason,
} from '@cat-factory/kernel'

// Mothership-mode notification DELIVERY delegation (docs/initiatives/mothership-mode.md, PR 4).
//
// A mothership-mode local node runs the engine on the laptop and PERSISTS the notification row on
// the mothership (the remote `notificationRepository`), but it cannot DELIVER that notification to
// the org's external transports: the Slack bot token is sealed with the MOTHERSHIP's encryption
// key, which by product decision 3 never reaches the laptop. So a run that raises `merge_review` /
// `ci_failed` / `release_regression` on a developer's machine lands in the inbox but never reaches
// the team's Slack channel.
//
// This module is the runtime-neutral spine of that delegation: the wire envelope, the fetch-based
// client the laptop posts through, and the {@link NotificationChannel} adapter that plugs the
// client into the engine's existing fan-out with no engine change. It is the deliberate
// counterpart to the persistence RPC and the real-time upstream publish — ADR 0009 records that
// cross-cutting concerns (real-time, email, Slack, telemetry) are delegated over their OWN
// `/internal/*` endpoints rather than falling out of the persistence proxy.
//
// IN-APP delivery is deliberately NOT part of this channel: a laptop-raised notification already
// reaches the mothership's browsers as a `notification` WorkspaceEvent over the real-time upstream
// relay (`POST /internal/events/publish`). The mothership therefore delivers a delegated
// notification through its EXTERNAL channels only, so the two `/internal/*` surfaces don't both
// push the same frame.

/**
 * The request a mothership-mode node posts to `POST /internal/notifications/deliver`.
 *
 * It carries only IDENTIFIERS, never the notification's content: the mothership re-reads the row
 * from its own store and delivers THAT. A compromised node token can therefore only ask the
 * mothership to re-deliver a notification that already exists in an account it can already reach —
 * it can never inject forged text into the org's Slack channel.
 *
 * The one thing the row does NOT carry is `reason`: which lifecycle edge this delegation is for.
 * The mothership cannot re-derive it, because the two edges that decide whether its alert
 * transports fire are indistinguishable in the persisted row (an escalation and a fresh raise are
 * both `open`). Left off the wire, every dismissal a laptop made would reach the org's Slack as a
 * fresh "Decision needed". So it is REQUIRED, and a body without it is refused rather than
 * defaulted: guessing `raised` mails a decision already made, guessing `settled` silences the
 * alert the delegation exists to send, and a node one build behind is better off failing loudly.
 */
export interface DelegatedNotificationRequest {
  workspaceId: string
  notificationId: string
  reason: NotificationDeliveryReason
}

/** The client half: asks a mothership to deliver one of its own notification rows. */
export interface MachineNotificationClient {
  /**
   * Ask the mothership to deliver `notificationId` (of `workspaceId`) through its external
   * channels. Rejects on a transport/HTTP failure so the caller can surface it; delivery itself is
   * best-effort on the mothership side (the persisted row is the source of truth).
   */
  deliver(
    workspaceId: string,
    notificationId: string,
    reason: NotificationDeliveryReason,
  ): Promise<void>
}

export interface HttpMachineNotificationClientOptions {
  baseUrl: string
  /** The machine token, as a fixed string OR a provider read per request (may return null). */
  token: string | (() => string | null)
  fetchImpl?: typeof fetch
  /**
   * Abort the round-trip after this long. A notification raise is AWAITED inside an engine state
   * transition, so an unreachable mothership must fail fast rather than stall the run.
   */
  timeoutMs?: number
}

/** Default request timeout — short, because a raise awaits it inside a state transition. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * A fetch-based {@link MachineNotificationClient} that posts to a mothership's
 * `POST /internal/notifications/deliver`, presenting the node's machine token. Mirrors
 * {@link HttpPersistenceRpcClient}'s auth contract (a fixed token OR a per-request provider, so a
 * token cached after boot by the mothership login flow is picked up without a restart).
 */
export class HttpMachineNotificationClient implements MachineNotificationClient {
  constructor(private readonly opts: HttpMachineNotificationClientOptions) {}

  async deliver(
    workspaceId: string,
    notificationId: string,
    reason: NotificationDeliveryReason,
  ): Promise<void> {
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    // No token yet (a node booted before the mothership login): there is nothing to delegate to,
    // and a guaranteed-403 round-trip per notification is pure waste. The row is still persisted.
    if (!token) return
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(
      `${this.opts.baseUrl.replace(/\/$/, '')}/internal/notifications/deliver`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId,
          notificationId,
          reason,
        } satisfies DelegatedNotificationRequest),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      throw new Error(`mothership notification delivery failed with HTTP ${res.status}`)
    }
  }
}

export interface RemoteNotificationChannelOptions {
  client: MachineNotificationClient
  /**
   * Surface a delegation failure (unreachable mothership, expired machine token, a workspace that
   * fell out of the node's scope) without breaking the raise. Mirrors
   * `SlackNotificationChannel.onError` — best-effort delivery still has to be diagnosable.
   */
  onError?: (error: unknown, ctx: { workspaceId: string; notificationId: string }) => void
}

/**
 * The mothership-mode {@link NotificationChannel}: hands the notification's IDENTITY to the
 * mothership, which delivers it through the org's external transports (Slack today) using
 * credentials that never leave the mothership.
 *
 * Composed alongside the laptop's own channels (the in-app push stays local — see the module note),
 * so the engine's raise path is unchanged. Self-swallowing per the port's best-effort contract.
 */
export class RemoteNotificationChannel implements NotificationChannel {
  constructor(private readonly opts: RemoteNotificationChannelOptions) {}

  async deliver(
    workspaceId: string,
    notification: Notification,
    reason: NotificationDeliveryReason,
  ): Promise<void> {
    try {
      await this.opts.client.deliver(workspaceId, notification.id, reason)
    } catch (error) {
      this.opts.onError?.(error, { workspaceId, notificationId: notification.id })
    }
  }
}
