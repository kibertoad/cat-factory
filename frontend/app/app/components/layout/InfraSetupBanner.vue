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
// Two KINDS of card share this surface, and the difference drives the dismissal fork:
//   - a setup gap (`not_defined`) is a stable operator decision, so both dismissals are offered;
//   - an OUTAGE (`unreachable` — configured, but the reachability watcher's live probe can't reach
//     it) is a health state, so ONLY the session dismissal is offered. A permanent "don't notify me
//     again" on a transient failure would let one click silence every future outage, and the outage
//     that matters is always the next one. `isInfraSetupHealthStatus` (contracts) is the single
//     definition both this component and the store's re-nag logic key off.
//
// Freshness note: a setup gap clears on the next board load after the operator configures the area
// via the deep-link, not the instant the config panel saves — the projection is recomputed on
// snapshot (re)load. An OUTAGE is different: it arrives and clears live, pushed as an `infraSetup`
// event by the watcher and applied by `workspace.patchInfraSetup`.
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
// The localStorage key holding the permanent per-user dismissals lives in `@cat-factory/contracts`
// (a dependency-free package the SPA and the e2e suite both import), so the key + shape can't drift
// between this component and the e2e seed in `backend/internal/e2e/tests/helpers.ts` (`pinWorkspace`).
import { INFRA_SETUP_DISMISSED_STORAGE_KEY, isInfraSetupHealthStatus } from '@cat-factory/contracts'
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
// Each area carries its OWN outage title rather than interpolating the area name into a shared one:
// a predicate adjective ("is unreachable") agrees with its subject's gender in most of the locales we
// ship, so `{area} is unreachable` cannot be translated correctly as one string. The outage BODY and
// action are shared, because neither refers back to the area — each locale's body opens with its own
// fixed subject noun for exactly that reason.
const AREA_META: Record<
  InfraSetupArea,
  {
    icon: string
    titleKey: string
    unreachableTitleKey: string
    bodyKey: string
    actionKey: string
    onConfigure: () => void
  }
> = {
  agentExecutor: {
    icon: 'i-lucide-server-cog',
    titleKey: 'layout.infraSetupBanner.agentExecutor.title',
    unreachableTitleKey: 'layout.infraSetupBanner.agentExecutor.unreachableTitle',
    bodyKey: 'layout.infraSetupBanner.agentExecutor.body',
    actionKey: 'layout.infraSetupBanner.agentExecutor.action',
    onConfigure: () => ui.openProviderConnection('runner-pool'),
  },
  ephemeralEnvironments: {
    icon: 'i-lucide-flask-conical',
    titleKey: 'layout.infraSetupBanner.ephemeralEnvironments.title',
    unreachableTitleKey: 'layout.infraSetupBanner.ephemeralEnvironments.unreachableTitle',
    bodyKey: 'layout.infraSetupBanner.ephemeralEnvironments.body',
    actionKey: 'layout.infraSetupBanner.ephemeralEnvironments.action',
    onConfigure: () => ui.openProviderConnection('environment'),
  },
  binaryStorage: {
    icon: 'i-lucide-hard-drive',
    titleKey: 'layout.infraSetupBanner.binaryStorage.title',
    unreachableTitleKey: 'layout.infraSetupBanner.binaryStorage.unreachableTitle',
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

/** One rendered card: the area plus whether it is an OUTAGE rather than a setup gap. */
interface AreaCard {
  area: InfraSetupArea
  /** True for a live-health status — drives the copy, the severity styling and the dismissal fork. */
  outage: boolean
}

const visible = computed<AreaCard[]>(() => {
  const status = workspace.infraSetup
  if (!status) return []
  return AREAS.filter(
    (area) =>
      (status[area] === 'not_defined' || isInfraSetupHealthStatus(status[area])) &&
      !ui.infraSetupSessionDismissed.includes(area) &&
      // The permanent dismissal covers SETUP GAPS only. An outage must re-nag whoever silenced the
      // "you haven't configured this" prompt, because it is a different claim about a different
      // state — they DID configure it, and it is now down.
      !(dismissedForUser.value.includes(area) && status[area] === 'not_defined'),
  ).map((area) => ({ area, outage: isInfraSetupHealthStatus(status[area]) }))
})

/**
 * The dismiss dropdown: the product wants the user asked WHICH kind of dismissal on close. An
 * outage offers the session option ONLY — see the fork note at the top of this file.
 */
function dismissMenu(card: AreaCard): DropdownMenuItem[][] {
  const session = {
    label: t('layout.infraSetupBanner.dismiss.session'),
    icon: 'i-lucide-clock',
    onSelect: () => ui.dismissInfraSetupForSession(card.area),
  }
  if (card.outage) return [[session]]
  return [
    [
      session,
      {
        label: t('layout.infraSetupBanner.dismiss.permanent'),
        icon: 'i-lucide-bell-off',
        onSelect: () => dismissPermanently(card.area),
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
      <!-- An OUTAGE reads red, a setup gap amber: one is something breaking now, the other is
           something never switched on, and a reader has to be able to tell at a glance. -->
      <div
        v-for="card in visible"
        :key="card.area"
        class="pointer-events-auto w-full max-w-3xl rounded-2xl border-2 p-5 shadow-2xl backdrop-blur"
        :class="
          card.outage ? 'border-red-500/70 bg-red-950/95' : 'border-amber-500/70 bg-amber-950/95'
        "
        :data-testid="`infra-setup-banner-${card.area}`"
        :data-infra-status="card.outage ? 'unreachable' : 'not_defined'"
      >
        <div class="flex items-start gap-4">
          <UIcon
            :name="card.outage ? 'i-lucide-plug-zap' : AREA_META[card.area].icon"
            class="mt-0.5 h-9 w-9 shrink-0"
            :class="card.outage ? 'text-red-400' : 'text-amber-400'"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2
                class="text-lg font-semibold"
                :class="card.outage ? 'text-red-100' : 'text-amber-100'"
              >
                {{
                  t(
                    card.outage
                      ? AREA_META[card.area].unreachableTitleKey
                      : AREA_META[card.area].titleKey,
                  )
                }}
              </h2>
              <UDropdownMenu :items="dismissMenu(card)" :content="{ align: 'end' }">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-x"
                  :aria-label="t('common.close')"
                  :data-testid="`infra-setup-dismiss-${card.area}`"
                />
              </UDropdownMenu>
            </div>
            <p class="mt-1 text-sm" :class="card.outage ? 'text-red-200/90' : 'text-amber-200/90'">
              {{
                card.outage
                  ? t('layout.infraSetupBanner.unreachable.body')
                  : t(AREA_META[card.area].bodyKey)
              }}
            </p>
            <div class="mt-4">
              <UButton
                :color="card.outage ? 'error' : 'warning'"
                variant="solid"
                icon="i-lucide-settings"
                :data-testid="`infra-setup-configure-${card.area}`"
                @click="AREA_META[card.area].onConfigure()"
              >
                {{
                  card.outage
                    ? t('layout.infraSetupBanner.unreachable.action')
                    : t(AREA_META[card.area].actionKey)
                }}
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
