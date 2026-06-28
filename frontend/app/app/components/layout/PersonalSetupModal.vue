<script setup lang="ts">
// "My setup": the user-scoped sibling of the Integrations hub. It lists the connections
// that belong to the SIGNED-IN USER rather than the workspace — a personal GitHub token,
// own-machine local model runners, and individual-usage (personal) subscriptions — which
// previously sat, confusingly, among the workspace-wide integrations. Each row reuses the
// existing per-panel handlers via `ui.openFromPersonal(...)`, so opening one closes this
// hub, reveals that panel, and gives it a "Back to My setup" control (IntegrationBackTitle).
const { t } = useI18n()
const ui = useUiStore()
const userSecrets = useUserSecretsStore()
const localModels = useLocalModelsStore()
const personalSubs = usePersonalSubscriptionsStore()

// Load the cheap user-scoped status whenever the hub opens, so each row's badge is accurate.
watch(
  () => ui.personalSetupOpen,
  (isOpen) => {
    if (!isOpen) return
    void userSecrets.load().catch(() => {})
    void localModels.load().catch(() => {})
    void personalSubs.load().catch(() => {})
  },
)

const open = computed({
  get: () => ui.personalSetupOpen,
  set: (v: boolean) => (v ? ui.openPersonalSetup() : ui.closePersonalSetup()),
})

// One row. `connected` drives the badge; `status` is the connected-state line (a count or
// "Connected"). Mirrors the Integrations hub's row shape so the two hubs look identical.
interface PersonalItem {
  key: string
  icon: string
  label: string
  description: string
  status?: string
  connected: boolean
  onClick: () => void
}

interface PersonalGroup {
  title: string
  items: PersonalItem[]
}

// Open a user-scoped panel from this hub (sets the "came from My setup" marker).
function go(fn: () => void) {
  ui.openFromPersonal(fn)
}

const groups = computed<PersonalGroup[]>(() => {
  const out: PersonalGroup[] = []

  // --- Source control --------------------------------------------------------
  const pat = !!userSecrets.statusFor('github_pat')
  out.push({
    title: t('layout.personalSetup.sourceControl.title'),
    items: [
      {
        key: 'github-pat',
        icon: 'i-lucide-key-round',
        label: t('layout.personalSetup.githubToken.label'),
        description: t('layout.personalSetup.githubToken.description'),
        status: pat ? t('layout.personalSetup.connected') : undefined,
        connected: pat,
        onClick: () => go(ui.openUserSecrets),
      },
    ],
  })

  // --- Models ----------------------------------------------------------------
  const runnerCount = localModels.endpoints.length
  const subCount = personalSubs.subscriptions.length
  out.push({
    title: t('layout.personalSetup.models.title'),
    items: [
      {
        key: 'local-runners',
        icon: 'i-lucide-server',
        label: t('layout.personalSetup.localRunners.label'),
        description: t('layout.personalSetup.localRunners.description'),
        status: runnerCount
          ? t('layout.personalSetup.connectedCount', { count: runnerCount }, runnerCount)
          : undefined,
        connected: runnerCount > 0,
        onClick: () => go(ui.openLocalModels),
      },
      {
        key: 'personal-subs',
        icon: 'i-lucide-user',
        label: t('layout.personalSetup.subscriptions.label'),
        description: t('layout.personalSetup.subscriptions.description'),
        status: subCount
          ? t('layout.personalSetup.connectedCount', { count: subCount }, subCount)
          : undefined,
        connected: subCount > 0,
        onClick: () => go(() => ui.openVendorCredentials('personal')),
      },
    ],
  })

  return out
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('layout.personalSetup.title')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-5">
        <p class="text-xs text-slate-400">
          {{ t('layout.personalSetup.intro') }}
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
                    {{ item.status || t('layout.personalSetup.connected') }}
                  </UBadge>
                  <span v-else class="text-[11px] text-slate-500">
                    {{ t('layout.personalSetup.notConnected') }}
                  </span>
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
