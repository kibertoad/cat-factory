<script setup lang="ts">
// The Integrations hub: a single modal that lists every external system the WORKSPACE can
// enable or link in. Each row reuses the existing per-integration panel handlers on the `ui`
// store (so the integrations themselves are unchanged); opening one closes the hub and
// reveals that integration's own panel/modal.
//
// Sections gate on the same `available` probes the navbar used, so a system that the backend
// has turned off simply doesn't appear here.
//
// Scope split: per-USER connections (a personal GitHub token, own-machine runners, personal
// subscriptions) now live in the "My setup" hub (UserMenu → My setup), NOT here — keeping
// this hub purely workspace-scoped. When auth is disabled there is no UserMenu to host them,
// so a "Personal (only you)" group falls back into this hub so they stay reachable.
const ui = useUiStore()
const auth = useAuthStore()
const github = useGitHubStore()
const slack = useSlackStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const tracker = useTrackerStore()
const releaseHealth = useReleaseHealthStore()
const providerConnections = useProviderConnectionsStore()
const userSecrets = useUserSecretsStore()
const apiKeys = useApiKeysStore()
const workspace = useWorkspaceStore()

// True when the per-user "My setup" hub is reachable (UserMenu renders only when signed in).
// When false (auth disabled / local mode) we fold the personal rows back into this hub so
// nothing becomes unreachable.
const personalHubReachable = computed(() => !!auth.user)

// The selected filing tracker, as a badge label ("GitHub Issues" / "Jira").
const trackerLabel = computed(() => {
  if (tracker.settings.tracker === 'github') return 'GitHub Issues'
  if (tracker.settings.tracker === 'jira') return 'Jira'
  return undefined
})

// Free-text filter over the rows (label + description), so a workspace with many enabled
// systems stays scannable. Reset when the hub re-opens.
const query = ref('')

// The observability connection status drives the hub's connected badge. Load it
// lazily when the hub opens (the secret-less connection view is cheap).
watch(
  () => ui.integrationsOpen,
  (isOpen) => {
    if (isOpen) {
      query.value = ''
      void releaseHealth.ensureLoaded().catch(() => {})
      void providerConnections.ensureLoaded().catch(() => {})
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

// One integration row. `connected` drives the green badge (`status` is its line — an
// account/team name or "Connected"); `attention` drives an amber badge (e.g. a source that
// is available but turned off) with `attentionLabel`. `recommended` tags an essential row
// with a "Recommended" chip while the workspace has nothing connected yet.
interface IntegrationItem {
  key: string
  icon: string
  label: string
  description: string
  status?: string
  connected?: boolean
  attention?: boolean
  attentionLabel?: string
  recommended?: boolean
  onClick: () => void
}

// A group may carry a small de-emphasised footer LINK (workspace config that isn't itself an
// integration, e.g. the issue-tracker settings) rendered under its rows rather than as a
// full row competing with the connections.
interface IntegrationFooterLink {
  key: string
  icon: string
  label: string
  status?: string
  onClick: () => void
}

interface IntegrationGroup {
  title: string
  items: IntegrationItem[]
  footerLink?: IntegrationFooterLink
}

// Run an integration's open handler, then dismiss the hub so its panel takes over.
// `openFromIntegrations` also marks that the panel was reached from here, so the panel
// renders a "Back to Integrations" control (see IntegrationBackTitle).
function go(fn: () => void) {
  ui.openFromIntegrations(fn)
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
        recommended: true,
        onClick: () => go(ui.openOpenRouter),
      },
      {
        key: 'vendors',
        icon: 'i-lucide-key-round',
        label: 'Vendors & keys',
        description: 'Workspace LLM subscriptions and provider API keys.',
        onClick: () => go(ui.openVendorCredentials),
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
      recommended: true,
      onClick: () => go(ui.openGitHub),
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
      // Available + enabled ⇒ offered (green); available + off ⇒ "Disabled" (amber);
      // not available ⇒ no badge (Jira needs connecting; GitHub needs its App).
      connected: src.available && src.enabled,
      attention: src.available && !src.enabled,
      attentionLabel: 'Disabled',
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
    // Choosing the filing tracker / writeback is workspace CONFIG, not an integration, so it
    // sits as a quiet footer link under the sources rather than a competing row.
    out.push({
      title: 'Task trackers',
      items: trackers,
      footerLink: {
        key: 'task:tracker',
        icon: 'i-lucide-list-checks',
        label: 'Issue tracker settings',
        status: trackerLabel.value,
        onClick: () => go(() => ui.openWorkspaceSettings('tracker')),
      },
    })
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

  // --- Infrastructure (ephemeral environments + self-hosted runner pool) -----
  // Each gates on its own availability probe, so a backend with the integration off
  // shows no dead row. The connected badge reflects a saved connection; the
  // ProviderConfigBanner handles the louder "missing mandatory fields" warning.
  const infra: IntegrationItem[] = []
  if (providerConnections.isAvailable('environment')) {
    const conn = providerConnections.connectionFor('environment')
    infra.push({
      key: 'environment',
      icon: 'i-lucide-cloud',
      label: 'Ephemeral environments',
      description: 'Where the Tester agent runs against a live preview environment.',
      status: conn ? 'Connected' : undefined,
      connected: !!conn,
      onClick: () => go(() => ui.openProviderConnection('environment')),
    })
  }
  if (providerConnections.isAvailable('runner-pool')) {
    const conn = providerConnections.connectionFor('runner-pool')
    infra.push({
      key: 'runner-pool',
      icon: 'i-lucide-server-cog',
      label: 'Self-hosted runner pool',
      description: 'Where the coding agents run when not using Cloudflare Containers.',
      status: conn ? 'Connected' : undefined,
      connected: !!conn,
      onClick: () => go(() => ui.openProviderConnection('runner-pool')),
    })
  }
  // Local-mode-only: the warm-container pool + checkout reuse for the local runner. Shown
  // only on the local-mode service (the controller 503s elsewhere, and `auth.localMode`
  // is set from /auth/config).
  if (auth.localMode?.enabled) {
    infra.push({
      key: 'local-mode',
      icon: 'i-lucide-container',
      label: 'Local mode',
      description: 'Warm container pool + per-repo checkout reuse for the local runner.',
      onClick: () => go(ui.openLocalModeSettings),
    })
  }
  if (infra.length) out.push({ title: 'Infrastructure', items: infra })

  // --- Personal (only you) — fallback when there is no UserMenu to host "My setup" -------
  // Per-user connections normally live in the My-setup hub; with auth disabled they fold in
  // here so they stay reachable. (The badge reflects the signed-in user's stored secret.)
  if (!personalHubReachable.value) {
    const pat = !!userSecrets.statusFor('github_pat')
    out.push({
      title: 'Personal (only you)',
      items: [
        {
          key: 'github-pat',
          icon: 'i-lucide-key-round',
          label: 'My GitHub token',
          description: 'A personal access token used for runs you start (pushes, PRs, CI, merge).',
          status: pat ? 'Connected' : undefined,
          connected: pat,
          onClick: () => go(ui.openUserSecrets),
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
  }

  return out
})

// Sort connected rows first, then amber "attention", then idle — a stable rank so each
// group reads "what's live" top-down without reshuffling unrelated rows.
function stateRank(item: IntegrationItem): number {
  if (item.connected) return 0
  if (item.attention) return 1
  return 2
}

const allItems = computed(() => groups.value.flatMap((g) => g.items))
const anyConnected = computed(() => allItems.value.some((i) => i.connected))
// Essential rows still unconnected — surfaced as the empty-workspace get-started shortcuts.
const recommendedActions = computed(() =>
  allItems.value.filter((i) => i.recommended && !i.connected),
)

function matches(text: string, q: string): boolean {
  return text.toLowerCase().includes(q)
}

// Groups after the search filter + connected-first sort. A footer link is kept only when it
// also matches the query (or the query is empty); a group with no surviving rows/link drops.
const filteredGroups = computed<IntegrationGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  return groups.value
    .map((g) => {
      const items = (
        q ? g.items.filter((i) => matches(i.label, q) || matches(i.description, q)) : g.items
      )
        .slice()
        .sort((a, b) => stateRank(a) - stateRank(b))
      const footerLink =
        g.footerLink && (!q || matches(g.footerLink.label, q)) ? g.footerLink : undefined
      return { ...g, items, footerLink }
    })
    .filter((g) => g.items.length || g.footerLink)
})
</script>

<template>
  <UModal v-model:open="open" title="Integrations" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <div class="space-y-5">
        <p class="text-xs text-slate-400">
          Connect and manage the external systems this workspace can link in.
        </p>

        <!-- Get-started cue: an empty workspace gets the two essentials up front so the first
             run isn't blocked on hunting for them. Hidden once anything is connected. -->
        <div
          v-if="!anyConnected && recommendedActions.length"
          class="rounded-lg border border-primary-500/40 bg-primary-500/10 p-3"
        >
          <div class="mb-2 flex items-center gap-2 text-sm font-medium text-primary-200">
            <UIcon name="i-lucide-rocket" class="h-4 w-4 shrink-0" />
            <span>Get started</span>
          </div>
          <p class="mb-3 text-xs text-slate-300">
            Connect a code source and a model provider to run your first pipeline.
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="item in recommendedActions"
              :key="`rec:${item.key}`"
              size="xs"
              color="primary"
              variant="soft"
              :icon="item.icon"
              @click="item.onClick()"
            >
              {{ item.label }}
            </UButton>
          </div>
        </div>

        <UInput
          v-model="query"
          icon="i-lucide-search"
          size="sm"
          placeholder="Search integrations…"
          class="w-full"
        />

        <p v-if="!filteredGroups.length" class="px-1 py-6 text-center text-sm text-slate-500">
          No integrations match “{{ query }}”.
        </p>

        <section v-for="group in filteredGroups" :key="group.title">
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
                  <UBadge v-else-if="item.attention" color="warning" variant="subtle" size="sm">
                    {{ item.attentionLabel || 'Needs attention' }}
                  </UBadge>
                  <span v-else class="text-[11px] text-slate-500">Not connected</span>
                  <UBadge
                    v-if="!anyConnected && item.recommended && !item.connected"
                    color="primary"
                    variant="subtle"
                    size="sm"
                  >
                    Recommended
                  </UBadge>
                </div>
                <p class="truncate text-xs text-slate-400">{{ item.description }}</p>
              </div>
              <UIcon name="i-lucide-chevron-right" class="h-4 w-4 shrink-0 text-slate-500" />
            </button>
          </div>

          <!-- De-emphasised workspace-config link (e.g. issue tracker settings). -->
          <button
            v-if="group.footerLink"
            type="button"
            class="mt-1.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-slate-400 transition hover:bg-slate-900/60 hover:text-slate-200"
            @click="group.footerLink.onClick()"
          >
            <UIcon :name="group.footerLink.icon" class="h-3.5 w-3.5 shrink-0" />
            <span class="flex-1 truncate">{{ group.footerLink.label }}</span>
            <span v-if="group.footerLink.status" class="shrink-0 text-slate-500">{{
              group.footerLink.status
            }}</span>
            <UIcon name="i-lucide-chevron-right" class="h-3.5 w-3.5 shrink-0 text-slate-600" />
          </button>
        </section>
      </div>
    </template>
  </UModal>
</template>
