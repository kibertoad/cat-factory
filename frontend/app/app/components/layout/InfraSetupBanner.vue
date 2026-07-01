<script setup lang="ts">
// Loud prompt that this deployment needs a piece of infrastructure the operator hasn't set up
// yet, so a whole class of agents can't run. Driven off the server-computed `infraSetup`
// snapshot projection (`not_defined` per area) — so it only fires on a runtime that actually
// requires the piece (the runner-pool executor matters on remote Node; binary storage on any
// runtime whose account picked no backend — incl. Cloudflare without an ARTIFACT_BUCKET binding;
// ephemeral test environments on any runtime that wires the integration).
//
// Positioning/stacking against the sibling advisory banners (AI-readiness, provider-config) is
// owned by the shared, click-through banner column in `pages/index.vue` — so concurrent prompts
// stack vertically instead of drawing on top of each other. This component only stacks its OWN
// (up to three) area cards; each card re-enables pointer events while the column stays inert.
//
// Dismissal offers the two choices the product asks for: hide for THIS SESSION (a ui-store flag,
// cleared on workspace switch, re-nags next load) or "I'm OK with the limitations, don't notify
// me again" — a PERMANENT, per-USER dismissal persisted in localStorage keyed by the signed-in
// user id (so it's this-user-only and survives reloads).
//
// Scope note: the permanent dismissal is per-USER and DEPLOYMENT-wide, not per-account. That is
// exact for `agentExecutor`/`ephemeralEnvironments` (deployment-level wiring). `binaryStorage` is
// per-account, so a user who permanently silences it on one account won't be re-nagged on another
// account that also has no storage — an accepted trade-off (the setting stays reachable from
// account settings, and the SESSION dismissal re-nags on the next load regardless).
//
// Freshness note: `infraSetup` is a server projection recomputed only on snapshot (re)load, so a
// banner clears on the next board load after the operator configures the area via the deep-link,
// not the instant the config panel saves.
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
// The localStorage key holding the permanent per-user dismissals lives in `@cat-factory/contracts`
// (a dependency-free package the SPA and the e2e suite both import), so the key + shape can't drift
// between this component and the e2e seed in `backend/internal/e2e/tests/helpers.ts` (`pinWorkspace`).
import { INFRA_SETUP_DISMISSED_STORAGE_KEY } from '@cat-factory/contracts'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { InfraSetupArea } from '~/types/domain'

const { t } = useI18n()
const ui = useUiStore()
const auth = useAuthStore()
const workspace = useWorkspaceStore()

// Severity order: no executor blocks EVERY agent, so it leads; a missing test environment blocks
// only testing agents; missing storage only degrades the UI-tester's screenshots.
const AREAS: InfraSetupArea[] = ['agentExecutor', 'ephemeralEnvironments', 'binaryStorage']

// Exhaustive per-area presentation (an exhaustive `Record<InfraSetupArea, …>`, so adding an area
// without a meta entry fails typecheck — the tier-2 guard). The i18n keys are resolved
// dynamically (`t(AREA_META[area].titleKey)`), so tier-1 typed-key checking doesn't cover them;
// the `i18n:check` drift guard (tier 3) catches any that are absent from the catalog. `action`
// deep-links into the relevant setup surface.
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
  INFRA_SETUP_DISMISSED_STORAGE_KEY,
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
    <!-- One polite live region for ALL area cards (plus the sibling AI/provider banners) rather
         than an assertive `role="alert"` per card — an advisory setup nag shouldn't interrupt a
         screen reader, and up to three stacked alerts would spam it. -->
    <div
      v-if="visible.length > 0"
      class="flex w-full flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      <div
        v-for="area in visible"
        :key="area"
        class="pointer-events-auto w-full max-w-3xl rounded-2xl border-2 border-amber-500/70 bg-amber-950/95 p-5 shadow-2xl backdrop-blur"
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
