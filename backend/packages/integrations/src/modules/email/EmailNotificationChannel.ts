import type {
  AudienceAccountMember,
  EmailSender,
  MembershipRepository,
  Notification,
  NotificationChannel,
  UserRepository,
  WorkspaceAccessRow,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { notificationAudienceUserIds } from '@cat-factory/kernel'
import {
  notificationDeepLink,
  renderNotificationEmail,
  resolveRecipientAddresses,
} from './emailNotification.logic.js'

// EmailNotificationChannel: an additional delivery transport for the existing notification
// mechanism, implementing the same `NotificationChannel` port the in-app and Slack channels do
// and composed alongside them via `CompositeNotificationChannel` — so the engine call sites
// that raise notifications are untouched.
//
// This is the lowest-common-denominator channel: a person who is not looking at the board and
// does not run the Slack integration otherwise learns that their pipeline parked on a decision
// only when they next open the app. WHICH types reach it is the notification manager's call
// (`RoutedNotificationChannel` wraps this one); by default that is the high-impact set alone,
// so connecting a sender does not start mailing a board's members about every step of every run.
//
// Runtime-neutral (fetch through the account's EmailSender + DB reads), so it lives here in
// @cat-factory/integrations and serves BOTH runtime facades.
//
// On deliver: resolve the workspace's account → its configured sender (unconfigured ⇒ silence,
// the standard opt-in pass-through), resolve the AUDIENCE the same way workspace access does,
// batch-read their addresses, render, and send one message per recipient with per-recipient
// error isolation.

export interface EmailNotificationChannelDependencies {
  workspaceRepository: WorkspaceRepository
  /** Account memberships, for the audience (see `notificationAudienceUserIds`). */
  membershipRepository: MembershipRepository
  /** Explicit board roster rows, for a restricted board's audience. */
  workspaceMemberRepository: WorkspaceMemberRepository
  /** Resolves recipients' email addresses in ONE batched read. */
  userRepository: UserRepository
  /**
   * The account's configured transactional sender (SendGrid / Resend), or null when the
   * account never connected one. Wired from `EmailConnectionService.resolveSender`, so the
   * API key is decrypted in-memory at send time and never held here.
   */
  resolveSender: (accountId: string) => Promise<EmailSender | null>
  /** The deployment's public SPA base URL, for the "open in cat-factory" link. */
  appBaseUrl?: string
  /**
   * Optional observability hook invoked when a delivery attempt fails. Delivery is
   * best-effort (a provider outage must never break the notification lifecycle), but a
   * swallowed failure should still be diagnosable — the facades wire this to their structured
   * logger, so a rejected API key or a bounced address surfaces instead of vanishing. Mirrors
   * `SlackNotificationChannel.onError`. `recipientCount` is reported rather than the addresses:
   * a log line is not a place to put a roster of people's email addresses.
   */
  onError?: (
    error: unknown,
    context: {
      workspaceId: string
      notificationId: string
      type: string
      recipientCount?: number
    },
  ) => void
}

/** How many sends are in flight at once (one external call per recipient is inherent). */
const SEND_CONCURRENCY = 4

export class EmailNotificationChannel implements NotificationChannel {
  constructor(private readonly deps: EmailNotificationChannelDependencies) {}

  async deliver(workspaceId: string, notification: Notification): Promise<void> {
    try {
      await this.send(workspaceId, notification)
    } catch (error) {
      // Best-effort: never let a provider outage/misconfig break the notification lifecycle
      // (CompositeNotificationChannel also isolates us, belt-and-braces).
      this.deps.onError?.(error, {
        workspaceId,
        notificationId: notification.id,
        type: notification.type,
      })
    }
  }

  private async send(workspaceId: string, notification: Notification): Promise<void> {
    const accessRow = await this.deps.workspaceRepository.accessRowOf(workspaceId)
    if (!accessRow) return
    // A legacy (unscoped) board has no account, so there is no connected sender to resolve
    // and nothing to send through. Its owner still sees the card in the inbox.
    if (!accessRow.accountId) return

    const sender = await this.deps.resolveSender(accessRow.accountId)
    if (!sender) return // the account never connected a sender: silence, not a failure

    const addresses = await this.resolveAddresses(workspaceId, accessRow.accountId, accessRow)
    if (addresses.length === 0) return

    const link = notificationDeepLink(this.deps.appBaseUrl, workspaceId, notification)
    const message = renderNotificationEmail(notification, { link })

    await this.fanOut(addresses, async (to) => {
      try {
        await sender.send({ to, ...message })
      } catch (error) {
        // Per-recipient isolation, one level below the composite's per-channel isolation: one
        // bad address (a bounce, a suppression-list hit) must not cost every other recipient
        // their notification.
        this.deps.onError?.(error, {
          workspaceId,
          notificationId: notification.id,
          type: notification.type,
          recipientCount: 1,
        })
      }
    })
  }

  /**
   * The audience's email addresses. Three batched reads (the account roster, the board
   * roster, then the users by id) — never a point-read per member, which is the banned N+1
   * and would be one round trip per person on every notification.
   */
  private async resolveAddresses(
    workspaceId: string,
    accountId: string,
    accessRow: WorkspaceAccessRow,
  ): Promise<string[]> {
    const [memberships, rosterRows] = await Promise.all([
      this.deps.membershipRepository.listByAccount(accountId),
      this.deps.workspaceMemberRepository.listByWorkspace(workspaceId),
    ])
    const accountMembers: AudienceAccountMember[] = memberships.map((m) => ({
      userId: m.userId,
      roles: m.roles,
    }))
    const userIds = notificationAudienceUserIds({
      workspace: accessRow,
      accountMembers,
      workspaceMemberUserIds: rosterRows.map((row) => row.userId),
    })
    if (userIds.length === 0) return []
    const users = await this.deps.userRepository.listByIds(userIds)
    return resolveRecipientAddresses(users.map((user) => user.email))
  }

  /** Run `task` over `items` with a bounded number in flight. */
  private async fanOut(items: string[], task: (item: string) => Promise<void>): Promise<void> {
    let next = 0
    const workers = Array.from({ length: Math.min(SEND_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!
        await task(item)
      }
    })
    await Promise.all(workers)
  }
}
