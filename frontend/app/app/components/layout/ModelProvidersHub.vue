<script setup lang="ts">
// The Model providers hub: where the ENGINES the harnesses run on are connected.
//
// Split out of the Integrations hub deliberately. Both are technically "external systems we
// hold a credential for", but they answer different questions: an integration is an OPTIONAL
// system that feeds a run context or receives its output (source control, trackers, documents,
// chat, observability), while a model provider is what actually executes the work — with none
// connected, nothing runs at all. Listing the providers among a dozen optional connectors
// buried the one connection every deployment must make.
//
// Rows reuse the existing per-provider panel handlers on the `ui` store via
// `ui.openFromModelProviders(...)`, so opening one closes this hub and gives that panel a
// "Back to Model providers" control (IntegrationBackTitle). Layout mirrors the Integrations
// hub row-for-row so the two read as siblings.
const { t } = useI18n()
const ui = useUiStore()
const apiKeys = useApiKeysStore()
const localModels = useLocalModelsStore()
const personalSubs = usePersonalSubscriptionsStore()
const workspace = useWorkspaceStore()

const open = computed({
  get: () => ui.modelProvidersOpen,
  set: (v: boolean) => (v ? ui.openModelProviders() : ui.closeModelProviders()),
})

// Free-text filter over the rows (label + description), matching the Integrations hub.
// Declared before the `immediate` watch below, which resets it on open.
const query = ref('')

// Load the cheap status reads each time the hub opens so every badge is accurate.
watch(
  () => ui.modelProvidersOpen,
  (isOpen) => {
    if (!isOpen) return
    query.value = ''
    if (workspace.workspaceId) void apiKeys.load(workspace.workspaceId).catch(() => {})
    void localModels.load().catch(() => {})
    void personalSubs.load().catch(() => {})
  },
  // Lazy v-if mount: the hub mounts with `modelProvidersOpen` already true → load immediately.
  { immediate: true },
)

/** One provider row. `connected` drives the green badge; `status` is its line. */
interface ProviderItem {
  key: string
  icon: string
  label: string
  description: string
  status?: string
  connected?: boolean
  /** Tags the fastest path to a working deployment while nothing is connected yet. */
  recommended?: boolean
  onClick: () => void
}

interface ProviderGroup {
  title: string
  /** Rendered under the group's rows — the scope caveat for the personal group. */
  note?: string
  items: ProviderItem[]
}

function go(fn: () => void) {
  ui.openFromModelProviders(fn)
}

const groups = computed<ProviderGroup[]>(() => {
  const openRouterKeyConnected = apiKeys.configuredProviders.has('openrouter')
  const runnerCount = localModels.endpoints.length
  const subCount = personalSubs.subscriptions.length

  return [
    // --- Workspace-wide providers ------------------------------------------
    // An OpenRouter key is the fastest path to 300+ models, so it leads.
    {
      title: t('layout.modelProvidersHub.groups.workspace'),
      items: [
        {
          key: 'openrouter',
          icon: 'i-lucide-waypoints',
          label: 'OpenRouter',
          description: t('layout.modelProvidersHub.items.openrouter.description'),
          status: openRouterKeyConnected
            ? t('layout.modelProvidersHub.status.keyConnected')
            : undefined,
          connected: openRouterKeyConnected,
          recommended: true,
          onClick: () => go(ui.openOpenRouter),
        },
        {
          key: 'vendors',
          icon: 'i-lucide-key-round',
          label: t('layout.modelProvidersHub.items.vendors.label'),
          description: t('layout.modelProvidersHub.items.vendors.description'),
          onClick: () => go(ui.openVendorCredentials),
        },
      ],
    },
    // --- Personal (per-user) providers -------------------------------------
    // These live on the user, not the workspace, and are also reachable from "My setup".
    // They are listed here as full rows rather than a pointer link because this hub is
    // scoped by TOPIC (what runs the work) rather than by ownership — "where do I put my
    // Claude plan" is the single most common reason to open it.
    {
      title: t('layout.modelProvidersHub.groups.personal'),
      note: t('layout.modelProvidersHub.groups.personalNote'),
      items: [
        {
          key: 'personal-subs',
          icon: 'i-lucide-user',
          label: t('layout.modelProvidersHub.items.personalSubs.label'),
          description: t('layout.modelProvidersHub.items.personalSubs.description'),
          status: subCount
            ? t('layout.modelProvidersHub.status.connectedCount', { count: subCount }, subCount)
            : undefined,
          connected: subCount > 0,
          onClick: () => go(() => ui.openVendorCredentials('personal')),
        },
        {
          key: 'local-runners',
          icon: 'i-lucide-server',
          label: t('layout.modelProvidersHub.items.localRunners.label'),
          description: t('layout.modelProvidersHub.items.localRunners.description'),
          status: runnerCount
            ? t(
                'layout.modelProvidersHub.status.connectedCount',
                { count: runnerCount },
                runnerCount,
              )
            : undefined,
          connected: runnerCount > 0,
          onClick: () => go(ui.openLocalModels),
        },
      ],
    },
  ]
})

// Connected rows first, then idle — a stable rank so each group reads "what's live" top-down.
function stateRank(item: ProviderItem): number {
  return item.connected ? 0 : 1
}

const allItems = computed(() => groups.value.flatMap((g) => g.items))
const anyConnected = computed(() => allItems.value.some((i) => i.connected))

function matches(text: string, q: string): boolean {
  return text.toLowerCase().includes(q)
}

const filteredGroups = computed<ProviderGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  return groups.value
    .map((g) => ({
      ...g,
      items: (q ? g.items.filter((i) => matches(i.label, q) || matches(i.description, q)) : g.items)
        .slice()
        .sort((a, b) => stateRank(a) - stateRank(b)),
    }))
    .filter((g) => g.items.length)
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('layout.modelProvidersHub.title')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-5" data-testid="model-providers-hub">
        <p class="text-xs text-slate-400">
          {{ t('layout.modelProvidersHub.intro') }}
        </p>

        <!-- Nothing connected at all is a hard stop, not a nudge: no provider means no agent
             step can run. Say so plainly rather than showing an empty list of options. -->
        <div
          v-if="!anyConnected"
          class="rounded-lg border border-primary-500/40 bg-primary-500/10 p-3"
        >
          <div class="mb-1.5 flex items-center gap-2 text-sm font-medium text-primary-200">
            <UIcon name="i-lucide-rocket" class="h-4 w-4 shrink-0" />
            <span>{{ t('layout.modelProvidersHub.getStarted.title') }}</span>
          </div>
          <p class="text-xs text-slate-300">
            {{ t('layout.modelProvidersHub.getStarted.body') }}
          </p>
        </div>

        <UInput
          v-model="query"
          icon="i-lucide-search"
          size="sm"
          :placeholder="t('layout.modelProvidersHub.searchPlaceholder')"
          class="w-full"
        />

        <p v-if="!filteredGroups.length" class="px-1 py-6 text-center text-sm text-slate-500">
          {{ t('layout.modelProvidersHub.noMatches', { query }) }}
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
              :data-testid="`model-provider-${item.key}`"
              @click="item.onClick()"
            >
              <UIcon :name="item.icon" class="h-5 w-5 shrink-0 text-slate-300" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium text-slate-100">{{ item.label }}</span>
                  <UBadge v-if="item.connected" color="success" variant="subtle" size="sm">
                    {{ item.status || t('layout.modelProvidersHub.status.connected') }}
                  </UBadge>
                  <span v-else class="text-[11px] text-slate-500">{{
                    t('layout.modelProvidersHub.status.notConnected')
                  }}</span>
                  <UBadge
                    v-if="!anyConnected && item.recommended"
                    color="primary"
                    variant="subtle"
                    size="sm"
                  >
                    {{ t('layout.modelProvidersHub.status.recommended') }}
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
          <p v-if="group.note" class="mt-1.5 px-1 text-[11px] text-slate-500">{{ group.note }}</p>
        </section>
      </div>
    </template>
  </UModal>
</template>
