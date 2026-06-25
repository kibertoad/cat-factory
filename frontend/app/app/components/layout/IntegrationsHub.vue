<script setup lang="ts">
// The Integrations hub: a single modal that lists every external system the
// workspace can enable or link in — replacing the per-integration buttons that
// used to clutter the left navbar. Each row reuses the existing per-integration
// panel handlers on the `ui` store (so the integrations themselves are unchanged);
// opening one closes the hub and reveals that integration's own panel/modal.
//
// Sections gate on the same `available` probes the navbar used, so a system that
// the backend has turned off simply doesn't appear here.
const ui = useUiStore()
const github = useGitHubStore()
const slack = useSlackStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const tracker = useTrackerStore()
const releaseHealth = useReleaseHealthStore()
const userSecrets = useUserSecretsStore()
const apiKeys = useApiKeysStore()
const workspace = useWorkspaceStore()

// The selected filing tracker, as a badge label ("GitHub Issues" / "Jira").
const trackerLabel = computed(() => {
  if (tracker.settings.tracker === 'github') return 'GitHub Issues'
  if (tracker.settings.tracker === 'jira') return 'Jira'
  return undefined
})

// The observability connection status drives the hub's connected badge. Load it
// lazily when the hub opens (the secret-less connection view is cheap).
watch(
  () => ui.integrationsOpen,
  (isOpen) => {
    if (isOpen) {
      void releaseHealth.ensureLoaded().catch(() => {})
      void userSecrets.load().catch(() => {})
      // Drives the OpenRouter row's "Key connected" badge.
      if (workspace.workspaceId) void apiKeys.load(workspace.workspaceId).catch(() => {})
    }
  },
)

const open = computed({
  get: () => ui.integrationsOpen,
  set: (v: boolean) => (v ? ui.openIntegrations() : ui.closeIntegrations()),
})

// One integration row. `status` is the connected-state line shown under the label
// (an account/team name, "Connected", or a hint); `connected` drives the badge.
interface IntegrationItem {
  key: string
  icon: string
  label: string
  description: string
  status?: string
  connected?: boolean
  onClick: () => void
}

interface IntegrationGroup {
  title: string
  items: IntegrationItem[]
}

// Run an integration's open handler, then dismiss the hub so its panel takes over.
function go(fn: () => void) {
  fn()
  ui.closeIntegrations()
}

const groups = computed<IntegrationGroup[]>(() => {
  const out: IntegrationGroup[] = []

  // --- Models & providers ----------------------------------------------------
  // Top of the hub: an OpenRouter key is the fastest path to 300+ models, so it leads.
  const openRouterKeyConnected = apiKeys.configuredProviders.has('openrouter')
  out.push({
    title: 'Models & providers',
    items: [
      {
        key: 'openrouter',
        icon: 'i-lucide-waypoints',
        label: 'OpenRouter',
        description: 'One gateway to 300+ models — add your key and enable models in one place.',
        status: openRouterKeyConnected ? 'Key connected' : undefined,
        connected: openRouterKeyConnected,
        onClick: () => go(ui.openOpenRouter),
      },
      {
        key: 'vendors',
        icon: 'i-lucide-key-round',
        label: 'Vendors & keys',
        description: 'LLM vendor subscriptions and provider API keys.',
        onClick: () => go(ui.openVendorCredentials),
      },
      {
        key: 'local-runners',
        icon: 'i-lucide-server',
        label: 'My local runners',
        description: 'Your own-machine model runners (Ollama, LM Studio, vLLM…).',
        onClick: () => go(ui.openLocalModels),
      },
    ],
  })

  // --- Source control --------------------------------------------------------
  const code: IntegrationItem[] = []
  if (github.available) {
    code.push({
      key: 'github',
      icon: 'i-lucide-github',
      label: 'GitHub',
      description: 'Connect the workspace’s GitHub App, browse repos, PRs and issues.',
      status: github.connected ? github.connection?.accountLogin : undefined,
      connected: github.connected,
      onClick: () => go(ui.openGitHub),
    })
  }
  // Per-user GitHub PAT — works on every runtime (used for runs you initiate). Always
  // offered; the badge reflects whether the signed-in user has stored one.
  {
    const pat = userSecrets.statusFor('github_pat')
    code.push({
      key: 'github-pat',
      icon: 'i-lucide-key-round',
      label: 'My GitHub token',
      description: 'A personal access token used for runs you start (pushes, PRs, CI, merge).',
      status: pat ? 'Connected' : undefined,
      connected: !!pat,
      onClick: () => go(ui.openUserSecrets),
    })
  }
  if (code.length) out.push({ title: 'Source control', items: code })

  // --- Communication ---------------------------------------------------------
  const comms: IntegrationItem[] = []
  if (slack.available) {
    comms.push({
      key: 'slack',
      icon: 'i-lucide-slack',
      label: 'Slack',
      description: 'Route notifications to your team’s Slack workspace.',
      status: slack.connected ? slack.connection?.teamName : undefined,
      connected: slack.connected,
      onClick: () => go(ui.openSlack),
    })
  }
  if (comms.length) out.push({ title: 'Communication', items: comms })

  // --- Documents (dynamic sources: Confluence / Notion / GitHub) -------------
  if (documents.available && documents.sources.length) {
    const docs: IntegrationItem[] = documents.sources.map((src) => ({
      key: `doc:${src.source}`,
      icon: src.icon,
      label: src.label,
      description: `Link ${src.label} as a document source for requirements context.`,
      status: documents.isConnected(src.source) ? 'Connected' : undefined,
      connected: documents.isConnected(src.source),
      onClick: () => go(() => ui.openDocumentConnect(src.source)),
    }))
    if (documents.anyConnected) {
      docs.push({
        key: 'doc:import',
        icon: 'i-lucide-file-down',
        label: 'Import & spawn',
        description: 'Pull documents from a connected source and spawn structure.',
        onClick: () => go(() => ui.openDocumentImport(null)),
      })
    }
    out.push({ title: 'Documents', items: docs })
  }

  // --- Task trackers (dynamic sources: Jira / GitHub) ------------------------
  if (tasks.available && tasks.sources.length) {
    const trackers: IntegrationItem[] = tasks.sources.map((src) => ({
      key: `task:${src.source}`,
      icon: src.icon,
      label: src.label,
      description: `Link ${src.label} to import and reference tracker issues.`,
      // Available + enabled ⇒ offered (green); available + off ⇒ "Disabled";
      // not available ⇒ no badge (Jira needs connecting; GitHub needs its App).
      status: src.available ? (src.enabled ? undefined : 'Disabled') : undefined,
      connected: src.available && src.enabled,
      onClick: () => go(() => ui.openTaskConnect(src.source)),
    }))
    if (tasks.anyOffered) {
      trackers.push({
        key: 'task:import',
        icon: 'i-lucide-file-down',
        label: 'Import issues',
        description: 'Pull issues from a connected tracker onto the board.',
        onClick: () => go(() => ui.openTaskImport(null)),
      })
    }
    trackers.push({
      key: 'task:tracker',
      icon: 'i-lucide-list-checks',
      label: 'Issue tracker settings',
      description: 'Choose the filing tracker, enable linking sources, and configure writeback.',
      status: trackerLabel.value,
      connected: tracker.settings.tracker !== null,
      onClick: () => go(() => ui.openWorkspaceSettings('tracker')),
    })
    out.push({ title: 'Task trackers', items: trackers })
  }

  // --- Observability ---------------------------------------------------------
  // Gated like every other backend-toggleable system: hidden until a probe confirms
  // the observability module is enabled (`available === true`), so a disabled backend
  // doesn't show a dead "Connect" row that only 503s.
  if (releaseHealth.available) {
    out.push({
      title: 'Observability',
      items: [
        {
          key: 'observability',
          icon: 'i-lucide-activity',
          label: 'Post-release health',
          description: 'Watch monitors and SLOs after a release ships (Datadog).',
          status: releaseHealth.connection.connected ? 'Connected' : undefined,
          connected: releaseHealth.connection.connected,
          onClick: () => go(ui.openObservabilityConnection),
        },
      ],
    })
  }

  return out
})
</script>

<template>
  <UModal v-model:open="open" title="Integrations" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <div class="space-y-5">
        <p class="text-xs text-slate-400">
          Connect and manage the external systems this workspace can link in.
        </p>

        <section v-for="group in groups" :key="group.title">
          <h3 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ group.title }}
          </h3>
          <div class="space-y-1.5">
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              class="flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2.5 text-left transition hover:border-slate-700 hover:bg-slate-900"
              @click="item.onClick()"
            >
              <UIcon :name="item.icon" class="h-5 w-5 shrink-0 text-slate-300" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium text-slate-100">{{ item.label }}</span>
                  <UBadge v-if="item.connected" color="success" variant="subtle" size="sm">
                    {{ item.status || 'Connected' }}
                  </UBadge>
                </div>
                <p class="truncate text-xs text-slate-400">{{ item.description }}</p>
              </div>
              <UIcon name="i-lucide-chevron-right" class="h-4 w-4 shrink-0 text-slate-500" />
            </button>
          </div>
        </section>
      </div>
    </template>
  </UModal>
</template>
