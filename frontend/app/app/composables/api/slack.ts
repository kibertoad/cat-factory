import {
  connectSlackContract,
  disconnectSlackContract,
  getSlackConnectionContract,
  getSlackInstallUrlContract,
  getSlackMemberMappingContract,
  getSlackSettingsContract,
  listSlackChannelsContract,
  updateSlackMemberMappingContract,
  updateSlackSettingsContract,
} from '@cat-factory/contracts'
import type { SlackMemberMappingEntry, SlackNotificationSettings } from '~/types/slack'
import type { ApiContext } from './context'

/** Slack integration: per-account connection, per-workspace routing + member map. */
export function slackApi({ send, ws }: ApiContext) {
  return {
    // ---- slack integration (extra notification transport) -----------------
    // Per-account connection (manual bot-token paste + the OAuth "Add to Slack"
    // URL), per-workspace routing, and the per-account member map. A 503 from
    // `getSlackConnection` means the integration is off (the store hides its UI).
    getSlackConnection: (workspaceId: string) =>
      send(getSlackConnectionContract, { pathPrefix: ws(workspaceId) }),

    getSlackInstallUrl: (workspaceId: string) =>
      send(getSlackInstallUrlContract, { pathPrefix: ws(workspaceId) }),

    connectSlack: (workspaceId: string, token: string) =>
      send(connectSlackContract, { pathPrefix: ws(workspaceId), body: { token } }),

    disconnectSlack: (workspaceId: string) =>
      send(disconnectSlackContract, { pathPrefix: ws(workspaceId) }),

    listSlackChannels: (workspaceId: string) =>
      send(listSlackChannelsContract, { pathPrefix: ws(workspaceId) }),

    getSlackSettings: (workspaceId: string) =>
      send(getSlackSettingsContract, { pathPrefix: ws(workspaceId) }),

    updateSlackSettings: (
      workspaceId: string,
      body: { routes: SlackNotificationSettings['routes']; mentionsEnabled: boolean },
    ) => send(updateSlackSettingsContract, { pathPrefix: ws(workspaceId), body }),

    getSlackMemberMapping: (workspaceId: string) =>
      send(getSlackMemberMappingContract, { pathPrefix: ws(workspaceId) }),

    updateSlackMemberMapping: (workspaceId: string, entries: SlackMemberMappingEntry[]) =>
      send(updateSlackMemberMappingContract, { pathPrefix: ws(workspaceId), body: { entries } }),
  }
}
