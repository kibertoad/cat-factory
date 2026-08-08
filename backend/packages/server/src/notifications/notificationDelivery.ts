import { EmailNotificationChannel } from '@cat-factory/integrations'
import type {
  Clock,
  EmailSender,
  MembershipRepository,
  NotificationChannel,
  NotificationDeliveryChannel,
  NotificationSettingsRepository,
  UserRepository,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { RoutedNotificationChannel } from '@cat-factory/kernel'
import { NotificationSettingsService } from '@cat-factory/orchestration'
import { logger } from '../observability/logger.js'

// ---------------------------------------------------------------------------
// The routed half of notification delivery, built ONCE for both facades.
//
// Two things have to agree here and would drift if each facade assembled them: the
// notification MANAGER (a workspace's per-type, per-channel routing) must be the same
// service the settings API writes through, and each channel it owns must be wrapped in the
// gate — a channel a facade forgot to wrap ignores every mute a human set, and nothing
// fails. So a facade calls this, passes `router` into `CoreDependencies`, and composes the
// channels it returns.
//
// What is NOT here: Slack and the outbound webhooks. Both answer "which types" where their
// DESTINATION is declared (a Slack route's channel, a webhook endpoint's own `types`
// filter), so routing them again would be a second switch for a decided question.
// ---------------------------------------------------------------------------

export interface NotificationDeliveryInput {
  /** The manager's store. Absent ⇒ no routing store; see {@link buildNotificationDelivery}. */
  notificationSettingsRepository: NotificationSettingsRepository
  clock: Clock
  workspaceRepository: WorkspaceRepository
  membershipRepository: MembershipRepository
  workspaceMemberRepository: WorkspaceMemberRepository
  userRepository: UserRepository
  /**
   * The account's configured transactional sender, when the deployment wired the per-account
   * email module (`EmailConnectionService.resolveSender`). Absent ⇒ no email channel is built
   * at all, the standard opt-in pass-through.
   */
  resolveEmailSender?: (accountId: string) => Promise<EmailSender | null>
  /** The deployment's public SPA base URL, for the "open in cat-factory" deep link. */
  appBaseUrl?: string
}

export interface NotificationDeliverySupport {
  /** The manager: hand it to `CoreDependencies` so the settings API writes the same rows. */
  settingsService: NotificationSettingsService
  /** Wrap a channel the manager owns, so its deliveries obey the workspace's routing. */
  route(channel: NotificationDeliveryChannel, inner: NotificationChannel): NotificationChannel
  /** The email transport, or null when the deployment wired no per-account email module. */
  emailChannel: NotificationChannel | null
}

/**
 * Build the notification manager, the per-channel routing gate, and the email channel.
 *
 * The email channel is EXTERNAL in the mothership sense (it sends through the account's
 * sealed provider key), so a facade composes it into its external channel set beside Slack
 * and the webhook, not into the in-app half.
 */
export function buildNotificationDelivery(
  input: NotificationDeliveryInput,
): NotificationDeliverySupport {
  const settingsService = new NotificationSettingsService({
    notificationSettingsRepository: input.notificationSettingsRepository,
    clock: input.clock,
  })

  const route = (
    channel: NotificationDeliveryChannel,
    inner: NotificationChannel,
  ): NotificationChannel =>
    new RoutedNotificationChannel(channel, settingsService, inner, (error, ctx) =>
      // The gate fell back to the shipped default rather than dropping the notification; say
      // so, because a settings store that cannot be read is an outage in its own right.
      logger.warn('notification routing lookup failed; using the default route', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
    )

  const resolveSender = input.resolveEmailSender
  const emailChannel = resolveSender
    ? route(
        'email',
        new EmailNotificationChannel({
          workspaceRepository: input.workspaceRepository,
          membershipRepository: input.membershipRepository,
          workspaceMemberRepository: input.workspaceMemberRepository,
          userRepository: input.userRepository,
          resolveSender,
          ...(input.appBaseUrl ? { appBaseUrl: input.appBaseUrl } : {}),
          // Best-effort delivery still surfaces failures (a rejected API key, a bounced
          // address) through the structured logger so a broken sender is diagnosable.
          onError: (error, ctx) =>
            logger.warn('email notification delivery failed', {
              err: error instanceof Error ? error.message : String(error),
              ...ctx,
            }),
        }),
      )
    : null

  return { settingsService, route, emailChannel }
}
