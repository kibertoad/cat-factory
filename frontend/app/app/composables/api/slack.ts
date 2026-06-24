import type {
  SlackChannel,
  SlackConnection,
  SlackMemberMappingEntry,
  SlackNotificationSettings,
} from '~/types/slack'
import type { ApiContext } from './context'

/** Slack integration: per-account connection, per-workspace routing + member map. */
export function slackApi({ http, ws }: ApiContext) {
  return {
    // ---- slack integration (extra notification transport) -----------------
    // Per-account connection (manual bot-token paste + the OAuth "Add to Slack"
    // URL), per-workspace routing, and the per-account member map. A 503 from
    // `getSlackConnection` means the integration is off (the store hides its UI).
    getSlackConnection: (workspaceId: string) =>
      http<{ connection: SlackConnection | null; oauthEnabled: boolean }>(
        `${ws(workspaceId)}/slack/connection`,
      ),

    getSlackInstallUrl: (workspaceId: string) =>
      http<{ url: string }>(`${ws(workspaceId)}/slack/install-url`),

    connectSlack: (workspaceId: string, token: string) =>
      http<SlackConnection>(`${ws(workspaceId)}/slack/connect`, {
        method: 'POST',
        body: { token },
      }),

    disconnectSlack: (workspaceId: string) =>
      http(`${ws(workspaceId)}/slack/connection`, { method: 'DELETE' }),

    listSlackChannels: (workspaceId: string) =>
      http<{ channels: SlackChannel[] }>(`${ws(workspaceId)}/slack/channels`),

    getSlackSettings: (workspaceId: string) =>
      http<SlackNotificationSettings>(`${ws(workspaceId)}/slack/settings`),

    updateSlackSettings: (
      workspaceId: string,
      body: { routes: SlackNotificationSettings['routes']; mentionsEnabled: boolean },
    ) =>
      http<SlackNotificationSettings>(`${ws(workspaceId)}/slack/settings`, { method: 'PUT', body }),

    getSlackMemberMapping: (workspaceId: string) =>
      http<{ entries: SlackMemberMappingEntry[] }>(`${ws(workspaceId)}/slack/member-mapping`),

    updateSlackMemberMapping: (workspaceId: string, entries: SlackMemberMappingEntry[]) =>
      http<{ entries: SlackMemberMappingEntry[] }>(`${ws(workspaceId)}/slack/member-mapping`, {
        method: 'PUT',
        body: { entries },
      }),
  }
}
