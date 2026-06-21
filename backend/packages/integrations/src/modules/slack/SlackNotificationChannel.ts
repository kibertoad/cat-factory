import type {
  MembershipRepository,
  Notification,
  NotificationChannel,
  SecretCipher,
  SlackConnectionRepository,
  SlackMemberMappingRepository,
  SlackSettingsRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { SlackApiClient } from './SlackApiClient.js'
import { defaultSlackSettings, renderNotificationMessage, resolveRoute } from './slack.logic.js'

// SlackNotificationChannel: an additional delivery transport for the existing
// notification mechanism. It implements the same `NotificationChannel` port as
// the in-app channel and is composed alongside it via CompositeNotificationChannel
// — so the engine call sites that raise notifications are untouched.
//
// Runtime-neutral (fetch + decrypt + DB reads), so it lives here in
// @cat-factory/integrations and serves BOTH runtime facades. Delivery is
// best-effort: any failure is swallowed so it can never break the state
// transition that raised the notification (the row is already persisted).
//
// On deliver: resolve the workspace's account → its Slack connection (decrypt the
// bot token), read the workspace's routing, bail unless the notification's type
// is enabled with a channel, optionally resolve @-mentions from the per-account
// member map, render, and post.

export interface SlackNotificationChannelDependencies {
  workspaceRepository: WorkspaceRepository
  slackConnectionRepository: SlackConnectionRepository
  slackSettingsRepository: SlackSettingsRepository
  slackMemberMappingRepository: SlackMemberMappingRepository
  membershipRepository: MembershipRepository
  secretCipher: SecretCipher
  /** Slack Web API client; defaults to a fetch-backed one. */
  slackClient?: SlackApiClient
}

export class SlackNotificationChannel implements NotificationChannel {
  private readonly slack: SlackApiClient

  constructor(private readonly deps: SlackNotificationChannelDependencies) {
    this.slack = deps.slackClient ?? new SlackApiClient()
  }

  async deliver(workspaceId: string, notification: Notification): Promise<void> {
    try {
      await this.post(workspaceId, notification)
    } catch {
      // Best-effort: never let a Slack outage/misconfig break the notification
      // lifecycle. (CompositeNotificationChannel also isolates us, belt-and-braces.)
    }
  }

  private async post(workspaceId: string, notification: Notification): Promise<void> {
    const accountKey = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? workspaceId

    const connection = await this.deps.slackConnectionRepository.getByAccount(accountKey)
    if (!connection || connection.deletedAt) return

    const settingsRecord = await this.deps.slackSettingsRepository.getByWorkspace(workspaceId)
    const settings = settingsRecord
      ? {
          routes: this.parseRoutes(settingsRecord.routesJson),
          mentionsEnabled: settingsRecord.mentionsEnabled,
          updatedAt: settingsRecord.updatedAt,
        }
      : defaultSlackSettings(0)

    const channel = resolveRoute(settings, notification.type)
    if (!channel) return

    const mentions = settings.mentionsEnabled ? await this.resolveMentions(accountKey) : []
    const token = await this.deps.secretCipher.decrypt(connection.tokenCipher)
    const message = renderNotificationMessage(notification, channel, mentions)
    await this.slack.chatPostMessage(token, message as unknown as Record<string, unknown>)
  }

  /**
   * Resolve the Slack member ids to @-mention: every account member that has a
   * configured GitHub→Slack mapping. Best-effort — unmapped members are skipped.
   */
  private async resolveMentions(accountKey: string): Promise<string[]> {
    const [members, mapping] = await Promise.all([
      this.deps.membershipRepository.listByAccount(accountKey),
      this.deps.slackMemberMappingRepository.getByAccount(accountKey),
    ])
    if (members.length === 0 || mapping.length === 0) return []
    const slackByGithub = new Map(mapping.map((m) => [m.githubUserId, m.slackUserId]))
    const ids: string[] = []
    for (const member of members) {
      const slackId = slackByGithub.get(member.userId)
      if (slackId) ids.push(slackId)
    }
    return ids
  }

  private parseRoutes(routesJson: string): ReturnType<typeof defaultSlackSettings>['routes'] {
    try {
      const parsed = JSON.parse(routesJson)
      if (parsed && typeof parsed === 'object') {
        return parsed as ReturnType<typeof defaultSlackSettings>['routes']
      }
    } catch {
      // fall through to empty
    }
    return {}
  }
}
