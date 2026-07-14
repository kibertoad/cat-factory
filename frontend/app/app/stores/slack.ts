import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  SlackChannel,
  SlackConnection,
  SlackMemberMappingEntry,
  SlackNotificationSettings,
} from '~/types/domain'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Slack integration state: the account's connection (an extra delivery transport
 * for the notification mechanism), the per-workspace notification routing, the
 * channel picker, and the per-account @-mention member map. `available` mirrors
 * the backend's opt-in gate — a 503 from the connection probe means the
 * integration is off and the UI hides its entry points (exactly as the GitHub and
 * documents stores gate on their probes). Nothing is persisted client-side.
 */
export const useSlackStore = defineStore('slack', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed yet), true/false = integration on/off. */
  const available = ref<boolean | null>(null)
  /** The account's Slack connection, or null when not connected. */
  const connection = ref<SlackConnection | null>(null)
  /** Whether the OAuth "Add to Slack" flow is configured (else paste a token). */
  const oauthEnabled = ref(false)
  /** The workspace's notification routing, loaded on demand. */
  const settings = ref<SlackNotificationSettings | null>(null)
  /** Channels for the routing picker, loaded on demand. */
  const channels = ref<SlackChannel[]>([])
  const loadingChannels = ref(false)
  /** The account's GitHub→Slack member map, loaded on demand. */
  const memberMapping = ref<SlackMemberMappingEntry[]>([])
  const connecting = ref(false)
  const saving = ref(false)

  const connected = computed(() => connection.value !== null)

  /**
   * Probe the integration: a 503 (or any error) on the connection read means Slack
   * is off — hide the UI. On success, capture the connection + whether OAuth is
   * available. Called on workspace change, like the GitHub probe.
   */
  async function runProbe() {
    if (!workspace.workspaceId) return
    try {
      const { connection: conn, oauthEnabled: oauth } = await api.getSlackConnection(
        workspace.requireId(),
      )
      available.value = true
      connection.value = conn
      oauthEnabled.value = oauth
    } catch {
      available.value = false
      connection.value = null
    }
  }
  // Single-flight the probe (app-startup initiative, item 12) so the SideBar's board-open fan-out
  // (via `ensureProbed`) hits Slack once per board; `probe()` stays the on-demand refresh.
  const { probe, ensureProbed } = useSingleFlightProbe(runProbe, () => workspace.workspaceId)

  /** Resolve the "Add to Slack" OAuth URL (only when oauthEnabled). */
  function installUrl(): Promise<string> {
    return api.getSlackInstallUrl(workspace.requireId()).then((r) => r.url)
  }

  /** Connect by pasting a bot token (the always-available fallback). */
  async function connectWithToken(token: string) {
    connecting.value = true
    try {
      connection.value = await api.connectSlack(workspace.requireId(), token)
    } finally {
      connecting.value = false
    }
  }

  async function disconnect() {
    await api.disconnectSlack(workspace.requireId())
    connection.value = null
    channels.value = []
  }

  async function loadChannels() {
    loadingChannels.value = true
    try {
      channels.value = (await api.listSlackChannels(workspace.requireId())).channels
    } finally {
      loadingChannels.value = false
    }
  }

  async function loadSettings() {
    settings.value = await api.getSlackSettings(workspace.requireId())
  }

  async function updateSettings(body: {
    routes: SlackNotificationSettings['routes']
    mentionsEnabled: boolean
  }) {
    saving.value = true
    try {
      settings.value = await api.updateSlackSettings(workspace.requireId(), body)
    } finally {
      saving.value = false
    }
  }

  async function loadMemberMapping() {
    memberMapping.value = (await api.getSlackMemberMapping(workspace.requireId())).entries
  }

  async function updateMemberMapping(entries: SlackMemberMappingEntry[]) {
    saving.value = true
    try {
      memberMapping.value = (
        await api.updateSlackMemberMapping(workspace.requireId(), entries)
      ).entries
    } finally {
      saving.value = false
    }
  }

  return {
    available,
    connection,
    oauthEnabled,
    settings,
    channels,
    loadingChannels,
    memberMapping,
    connecting,
    saving,
    connected,
    probe,
    ensureProbed,
    installUrl,
    connectWithToken,
    disconnect,
    loadChannels,
    loadSettings,
    updateSettings,
    loadMemberMapping,
    updateMemberMapping,
  }
})
