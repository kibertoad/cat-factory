<script setup lang="ts">
import { showOverrideField } from '~/utils/uiMode'

// The Integrations hub: a single modal that lists the OPTIONAL external systems the WORKSPACE
// can enable or link in — the ones that feed a run its context (source control, documents,
// trackers) or receive its output (chat, observability). Each row reuses the existing
// per-integration panel handlers on the `ui` store (so the integrations themselves are
// unchanged); opening one closes the hub and reveals that integration's own panel/modal.
//
// Sections gate on the same `available` probes the navbar used, so a system that the backend
// has turned off simply doesn't appear here.
//
// Scope split 1 — MODEL PROVIDERS are NOT integrations here. They are the engines the
// harnesses run on (with none connected nothing runs at all), so they have their own
// top-level hub, `ModelProvidersHub.vue`. Keeping them out is the point: an integration is
// something a deployment can live without, and burying the one mandatory connection among a
// dozen optional ones is what made this hub confusing.
//
// Scope split 2 — per-USER connections (a personal GitHub token, own-machine runners, personal
// subscriptions) live in the "My setup" hub (UserMenu → My setup), NOT here, keeping this hub
// workspace-scoped. When auth is disabled there is no UserMenu to host them, so a "Personal
// (only you)" group falls back into this hub so the workspace-adjacent ones stay reachable
// (the model-shaped ones fall back into the Model providers hub instead).
const { t } = useI18n()
const ui = useUiStore()
const auth = useAuthStore()
const github = useGitHubStore()
const slack = useSlackStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const tracker = useTrackerStore()
const releaseHealth = useReleaseHealthStore()
const publicApiKeys = usePublicApiKeysStore()
const userSecrets = useUserSecretsStore()
const uiMode = useUiModeStore()

// True when the per-user "My setup" hub is reachable (UserMenu renders only when signed in).
// When false (auth disabled / local mode) we fold the personal rows back into this hub so
// nothing becomes unreachable.
const personalHubReachable = computed(() => !!auth.user)

// The selected filing tracker, as a badge label ("GitHub Issues" / "Jira" / "Linear").
const trackerLabel = computed(() => {
  if (tracker.settings.tracker === 'github') return 'GitHub Issues'
  if (tracker.settings.tracker === 'jira') return 'Jira'
  if (tracker.settings.tracker === 'linear') return 'Linear'
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
      void publicApiKeys.ensureLoaded().catch(() => {})
      void userSecrets.load().catch(() => {})
    }
  },
  // Lazy v-if mount: the hub mounts with `integrationsOpen` already true → load immediately.
  { immediate: true },
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

  // NOTE: model providers (OpenRouter, vendor keys, personal subscriptions, local runners)
  // are NOT listed here — they have their own top-level hub (`ModelProvidersHub.vue`, SideBar
  // → "Model providers"). See the scope split at the top of this file.

  // --- Source control --------------------------------------------------------
  const code: IntegrationItem[] = []
  if (github.available) {
    code.push({
      key: 'github',
      icon: 'i-lucide-github',
      label: 'GitHub',
      description: t('layout.integrationsHub.items.github.description'),
      status: github.connected ? github.connection?.accountLogin : undefined,
      connected: github.connected,
      recommended: true,
      onClick: () => go(ui.openGitHub),
    })
  }
  if (code.length)
    out.push({ title: t('layout.integrationsHub.groups.sourceControl'), items: code })

  // --- Communication ---------------------------------------------------------
  const comms: IntegrationItem[] = []
  if (slack.available) {
    comms.push({
      key: 'slack',
      icon: 'i-lucide-slack',
      label: 'Slack',
      description: t('layout.integrationsHub.items.slack.description'),
      status: slack.connected ? slack.connection?.teamName : undefined,
      connected: slack.connected,
      onClick: () => go(ui.openSlack),
    })
  }
  // The notification manager is always listed: it configures the channels every deployment has
  // (the in-app inbox, and email once an account connects a sender), so unlike the integrations
  // around it there is no connection to probe before it is useful.
  comms.push({
    key: 'notificationSettings',
    icon: 'i-lucide-bell',
    label: t('layout.integrationsHub.items.notificationSettings.label'),
    description: t('layout.integrationsHub.items.notificationSettings.description'),
    onClick: () => go(ui.openNotificationSettings),
  })
  if (comms.length)
    out.push({ title: t('layout.integrationsHub.groups.communication'), items: comms })

  // --- Documents (dynamic sources: Confluence / Notion / GitHub) -------------
  if (documents.available && documents.sources.length) {
    const docs: IntegrationItem[] = documents.sources.map((src) => ({
      key: `doc:${src.source}`,
      icon: src.icon,
      label: src.label,
      description: t('layout.integrationsHub.items.documentSource.description', {
        source: src.label,
      }),
      status: documents.isConnected(src.source)
        ? t('layout.integrationsHub.status.connected')
        : undefined,
      connected: documents.isConnected(src.source),
      onClick: () => go(() => ui.openDocumentConnect(src.source)),
    }))
    if (documents.anyConnected) {
      docs.push({
        key: 'doc:import',
        icon: 'i-lucide-file-down',
        label: t('layout.integrationsHub.items.documentImport.label'),
        description: t('layout.integrationsHub.items.documentImport.description'),
        onClick: () => go(() => ui.openDocumentImport()),
      })
    }
    // Per-DocKind template + exemplar links are workspace CONFIG over the imported corpus, not an
    // integration to connect — so they sit as a quiet footer link under the sources.
    out.push({
      title: t('layout.integrationsHub.groups.documents'),
      items: docs,
      footerLink: {
        key: 'doc:templates',
        icon: 'i-lucide-file-badge',
        label: t('layout.integrationsHub.items.documentTemplates.label'),
        onClick: () => go(() => ui.openDocumentTemplates()),
      },
    })
  }

  // --- Task trackers (dynamic sources: Jira / GitHub) ------------------------
  if (tasks.available && tasks.sources.length) {
    const trackers: IntegrationItem[] = tasks.sources.map((src) => ({
      key: `task:${src.source}`,
      icon: src.icon,
      label: src.label,
      description: t('layout.integrationsHub.items.taskSource.description', { source: src.label }),
      // Available + enabled ⇒ offered (green); available + off ⇒ "Disabled" (amber);
      // not available ⇒ no badge (Jira needs connecting; GitHub needs its App).
      connected: src.available && src.enabled,
      attention: src.available && !src.enabled,
      attentionLabel: t('layout.integrationsHub.status.disabled'),
      onClick: () => go(() => ui.openTaskConnect(src.source)),
    }))
    if (tasks.anyOffered) {
      trackers.push({
        key: 'task:import',
        icon: 'i-lucide-file-down',
        label: t('layout.integrationsHub.items.taskImport.label'),
        description: t('layout.integrationsHub.items.taskImport.description'),
        onClick: () => go(() => ui.openTaskImport(null)),
      })
      trackers.push({
        key: 'task:bug-hunt',
        icon: 'i-lucide-radar',
        label: t('layout.integrationsHub.items.bugHunt.label'),
        description: t('layout.integrationsHub.items.bugHunt.description'),
        onClick: () => go(() => ui.openBugHunt(null)),
      })
    }
    // Choosing the filing tracker / writeback is workspace CONFIG, not an integration, so it
    // sits as a quiet footer link under the sources rather than a competing row.
    out.push({
      title: t('layout.integrationsHub.groups.taskTrackers'),
      items: trackers,
      footerLink: {
        key: 'task:tracker',
        icon: 'i-lucide-list-checks',
        label: t('layout.integrationsHub.items.trackerSettings.label'),
        status: trackerLabel.value,
        onClick: () => go(() => ui.openWorkspaceSettings('tracker')),
      },
    })
  }

  // --- Observability ---------------------------------------------------------
  // Gated like every other backend-toggleable system: hidden until a probe confirms
  // the observability module is enabled (`available === true`), so a disabled backend
  // doesn't show a dead "Connect" row that only 503s.
  //
  // Also an ADVANCED-tier row. Post-release health is the one integration here that acts
  // AFTER delivery rather than during it — it watches monitors once a release ships and can
  // spawn an on-call agent — so it sits outside the everyday loop the basic tier serves.
  // Gated with `showOverrideField` rather than a bare `isAdvanced`: an already-connected
  // Datadog is live behaviour on this workspace, and a tier must never conceal a connection a
  // basic-mode user would then have no way to inspect or disconnect.
  if (
    releaseHealth.available &&
    showOverrideField(uiMode.isAdvanced, releaseHealth.connection.connected || null)
  ) {
    out.push({
      title: t('layout.integrationsHub.groups.observability'),
      items: [
        {
          key: 'observability',
          icon: 'i-lucide-activity',
          label: t('layout.integrationsHub.items.observability.label'),
          description: t('layout.integrationsHub.items.observability.description'),
          status: releaseHealth.connection.connected
            ? t('layout.integrationsHub.status.connected')
            : undefined,
          connected: releaseHealth.connection.connected,
          onClick: () => go(ui.openObservabilityConnection),
        },
      ],
    })
  }

  // --- Development (API access tokens) ---------------------------------------
  // Gated like observability: hidden until a probe confirms its module is wired
  // (`available === true`), so an unconfigured backend doesn't show a dead row.
  const development: IntegrationItem[] = []
  if (publicApiKeys.available) {
    const hasKeys = publicApiKeys.keys.length > 0
    development.push({
      key: 'api-tokens',
      icon: 'i-lucide-key-round',
      label: t('layout.integrationsHub.items.apiTokens.label'),
      description: t('layout.integrationsHub.items.apiTokens.description'),
      status: hasKeys ? t('layout.integrationsHub.status.connected') : undefined,
      connected: hasKeys,
      onClick: () => go(ui.openApiTokens),
    })
  }
  if (development.length)
    out.push({ title: t('layout.integrationsHub.groups.development'), items: development })

  // NOTE: Infrastructure (agent-container execution + Tester environments + the local-mode
  // warm pool/checkout + the private package registries a checkout installs from) is no longer
  // listed here — it moved to its OWN top-level navbar menu (SideBar → "Infrastructure" → the
  // tabbed Infrastructure window). See `ui.openInfrastructure`.

  // --- Personal (only you) — fallback when there is no UserMenu to host "My setup" -------
  // Per-user connections normally live in the My-setup hub; with auth disabled they fold in
  // here so they stay reachable. (The badge reflects the signed-in user's stored secret.)
  // Only the source-control one: the per-user MODEL connections are listed unconditionally
  // in the Model providers hub, so they need no fallback.
  if (!personalHubReachable.value) {
    const pat = !!userSecrets.statusFor('github_pat')
    out.push({
      title: t('layout.integrationsHub.groups.personal'),
      items: [
        {
          key: 'github-pat',
          icon: 'i-lucide-key-round',
          label: t('layout.integrationsHub.items.githubPat.label'),
          description: t('layout.integrationsHub.items.githubPat.description'),
          status: pat ? t('layout.integrationsHub.status.connected') : undefined,
          connected: pat,
          onClick: () => go(ui.openUserSecrets),
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
  <UModal
    v-model:open="open"
    :title="t('layout.integrationsHub.title')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <!-- Named for the same reason `model-providers-hub` is: the tutorial tour that explains
           what a connection adds to a run points at this list. -->
      <div class="space-y-5" data-testid="integrations-hub">
        <p class="text-xs text-slate-400">
          {{ t('layout.integrationsHub.intro') }}
        </p>

        <!-- Get-started cue: an empty workspace gets the two essentials up front so the first
             run isn't blocked on hunting for them. Hidden once anything is connected. -->
        <div
          v-if="!anyConnected && recommendedActions.length"
          class="rounded-lg border border-primary-500/40 bg-primary-500/10 p-3"
        >
          <div class="mb-2 flex items-center gap-2 text-sm font-medium text-primary-200">
            <UIcon name="i-lucide-rocket" class="h-4 w-4 shrink-0" />
            <span>{{ t('layout.integrationsHub.getStarted.title') }}</span>
          </div>
          <p class="mb-3 text-xs text-slate-300">
            {{ t('layout.integrationsHub.getStarted.body') }}
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
          :placeholder="t('layout.integrationsHub.searchPlaceholder')"
          class="w-full"
        />

        <p v-if="!filteredGroups.length" class="px-1 py-6 text-center text-sm text-slate-500">
          {{ t('layout.integrationsHub.noMatches', { query }) }}
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
              class="flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2.5 text-start transition hover:border-slate-700 hover:bg-slate-900"
              @click="item.onClick()"
            >
              <UIcon :name="item.icon" class="h-5 w-5 shrink-0 text-slate-300" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium text-slate-100">{{ item.label }}</span>
                  <UBadge v-if="item.connected" color="success" variant="subtle" size="sm">
                    {{ item.status || t('layout.integrationsHub.status.connected') }}
                  </UBadge>
                  <UBadge v-else-if="item.attention" color="warning" variant="subtle" size="sm">
                    {{ item.attentionLabel || t('layout.integrationsHub.status.needsAttention') }}
                  </UBadge>
                  <span v-else class="text-[11px] text-slate-500">{{
                    t('layout.integrationsHub.status.notConnected')
                  }}</span>
                  <UBadge
                    v-if="!anyConnected && item.recommended && !item.connected"
                    color="primary"
                    variant="subtle"
                    size="sm"
                  >
                    {{ t('layout.integrationsHub.status.recommended') }}
                  </UBadge>
                </div>
                <p class="truncate text-xs text-slate-400">{{ item.description }}</p>
              </div>
              <UIcon
                name="i-lucide-chevron-right"
                class="h-4 w-4 shrink-0 text-slate-500 rtl:-scale-x-100"
              />
            </button>
          </div>

          <!-- De-emphasised workspace-config link (e.g. issue tracker settings). -->
          <button
            v-if="group.footerLink"
            type="button"
            class="mt-1.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-start text-xs text-slate-400 transition hover:bg-slate-900/60 hover:text-slate-200"
            @click="group.footerLink.onClick()"
          >
            <UIcon :name="group.footerLink.icon" class="h-3.5 w-3.5 shrink-0" />
            <span class="flex-1 truncate">{{ group.footerLink.label }}</span>
            <span v-if="group.footerLink.status" class="shrink-0 text-slate-500">{{
              group.footerLink.status
            }}</span>
            <UIcon
              name="i-lucide-chevron-right"
              class="h-3.5 w-3.5 shrink-0 text-slate-600 rtl:-scale-x-100"
            />
          </button>
        </section>
      </div>
    </template>
  </UModal>
</template>
