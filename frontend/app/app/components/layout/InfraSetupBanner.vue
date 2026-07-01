<script setup lang="ts">
// Loud prompt that this deployment needs a piece of infrastructure the operator hasn't set up
// yet, so a whole class of agents can't run. Driven off the server-computed `infraSetup`
// snapshot projection (`not_defined` per area) — so it only fires on a runtime that actually
// requires the piece (e.g. the runner-pool executor + binary storage only matter on remote
// Node; ephemeral test environments on any runtime that wires the integration).
//
// Dismissal offers the two choices the product asks for: hide for THIS SESSION (a ui-store flag,
// cleared on workspace switch, re-nags next load) or "I'm OK with the limitations, don't notify
// me again" — a PERMANENT, per-USER dismissal persisted in localStorage keyed by the signed-in
// user id (so it's this-user-only and survives reloads).
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { InfraSetupArea } from '~/types/domain'

const { t } = useI18n()
const ui = useUiStore()
const auth = useAuthStore()
const workspace = useWorkspaceStore()

// Severity order: no executor blocks EVERY agent, so it leads; a missing test environment blocks
// only testing agents; missing storage only degrades the UI-tester's screenshots.
const AREAS: InfraSetupArea[] = ['agentExecutor', 'ephemeralEnvironments', 'binaryStorage']

// Exhaustive per-area presentation (leaf i18n keys mirror the area verbatim, so the typed
// message-key check covers each). `action` deep-links into the relevant setup surface.
const AREA_META: Record<
  InfraSetupArea,
  { icon: string; titleKey: string; bodyKey: string; actionKey: string; onConfigure: () => void }
> = {
  agentExecutor: {
    icon: 'i-lucide-server-cog',
    titleKey: 'layout.infraSetupBanner.agentExecutor.title',
    bodyKey: 'layout.infraSetupBanner.agentExecutor.body',
    actionKey: 'layout.infraSetupBanner.agentExecutor.action',
    onConfigure: () => ui.openProviderConnection('runner-pool'),
  },
  ephemeralEnvironments: {
    icon: 'i-lucide-flask-conical',
    titleKey: 'layout.infraSetupBanner.ephemeralEnvironments.title',
    bodyKey: 'layout.infraSetupBanner.ephemeralEnvironments.body',
    actionKey: 'layout.infraSetupBanner.ephemeralEnvironments.action',
    onConfigure: () => ui.openProviderConnection('environment'),
  },
  binaryStorage: {
    icon: 'i-lucide-hard-drive',
    titleKey: 'layout.infraSetupBanner.binaryStorage.title',
    bodyKey: 'layout.infraSetupBanner.binaryStorage.body',
    actionKey: 'layout.infraSetupBanner.binaryStorage.action',
    onConfigure: () => ui.openContentStorageSettings(),
  },
}

// Permanent, per-user dismissals: one shared localStorage record keyed BY user id (so it's
// scoped to the signed-in user and doesn't leak across accounts on a shared browser). No
// signed-in user (local/auth-off single-user mode) ⇒ the `local` bucket.
const permanentDismissed = useLocalStorage<Record<string, InfraSetupArea[]>>(
  'cat-factory:infra-setup-dismissed',
  {},
)
const userKey = computed(() => auth.user?.id ?? 'local')
const dismissedForUser = computed(() => permanentDismissed.value[userKey.value] ?? [])
function dismissPermanently(area: InfraSetupArea) {
  const current = permanentDismissed.value[userKey.value] ?? []
  if (!current.includes(area)) {
    permanentDismissed.value = {
      ...permanentDismissed.value,
      [userKey.value]: [...current, area],
    }
  }
}

const visible = computed<InfraSetupArea[]>(() => {
  const status = workspace.infraSetup
  if (!status) return []
  return AREAS.filter(
    (area) =>
      status[area] === 'not_defined' &&
      !ui.infraSetupSessionDismissed.includes(area) &&
      !dismissedForUser.value.includes(area),
  )
})

// The dismiss dropdown: the product wants the user asked WHICH kind of dismissal on close.
function dismissMenu(area: InfraSetupArea): DropdownMenuItem[][] {
  return [
    [
      {
        label: t('layout.infraSetupBanner.dismiss.session'),
        icon: 'i-lucide-clock',
        onSelect: () => ui.dismissInfraSetupForSession(area),
      },
      {
        label: t('layout.infraSetupBanner.dismiss.permanent'),
        icon: 'i-lucide-bell-off',
        onSelect: () => dismissPermanently(area),
      },
    ],
  ]
}
</script>

<template>
  <Transition name="fade">
    <div
      v-if="visible.length > 0"
      class="absolute inset-x-0 top-0 z-40 flex flex-col items-center gap-2 px-4 pt-4"
    >
      <div
        v-for="area in visible"
        :key="area"
        class="w-full max-w-3xl rounded-2xl border-2 border-amber-500/70 bg-amber-950/95 p-5 shadow-2xl backdrop-blur"
        role="alert"
        :data-testid="`infra-setup-banner-${area}`"
      >
        <div class="flex items-start gap-4">
          <UIcon :name="AREA_META[area].icon" class="mt-0.5 h-9 w-9 shrink-0 text-amber-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-lg font-semibold text-amber-100">
                {{ t(AREA_META[area].titleKey) }}
              </h2>
              <UDropdownMenu :items="dismissMenu(area)" :content="{ align: 'end' }">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-x"
                  :aria-label="t('common.close')"
                  :data-testid="`infra-setup-dismiss-${area}`"
                />
              </UDropdownMenu>
            </div>
            <p class="mt-1 text-sm text-amber-200/90">
              {{ t(AREA_META[area].bodyKey) }}
            </p>
            <div class="mt-4">
              <UButton
                color="warning"
                variant="solid"
                icon="i-lucide-settings"
                :data-testid="`infra-setup-configure-${area}`"
                @click="AREA_META[area].onConfigure()"
              >
                {{ t(AREA_META[area].actionKey) }}
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
