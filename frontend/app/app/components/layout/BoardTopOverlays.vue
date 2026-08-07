<script setup lang="ts">
import BoardToolbar from '~/components/layout/BoardToolbar.vue'
import ConnectionStatusBanner from '~/components/layout/ConnectionStatusBanner.vue'
import SpendWarningBanner from '~/components/layout/SpendWarningBanner.vue'
import GitHubPatBanner from '~/components/layout/GitHubPatBanner.vue'
import AiProvidersBanner from '~/components/layout/AiProvidersBanner.vue'
import ProviderConfigBanner from '~/components/layout/ProviderConfigBanner.vue'
import InfraSetupBanner from '~/components/layout/InfraSetupBanner.vue'
import DefaultTestEnvBanner from '~/components/layout/DefaultTestEnvBanner.vue'

// The single owner of the board's top overlay region: the toolbar pill, the corner nav
// trigger, and every advisory banner, laid out in ONE flex column.
//
// The column is the point. Each of these used to anchor itself (`absolute top-0`, its own
// z-index), which makes overlap a matter of who picked the higher number: the four advisory
// banners already deferred to a shared column, but the toolbar, the spend/connection/PAT
// banners and the nav trigger each positioned themselves, and a standing advisory covered the
// zoom/fit controls outright, for everyone, and the board-basics tour then ringed a control
// nobody could see. Stacking them in flow makes that overlap structurally impossible instead
// of merely tuned: no offset constant to keep in step with the pill's height, and a toolbar
// that grows (a wrapped row, a scrollbar on a narrow viewport) pushes the column down by
// exactly what it grew.
//
// The column is `pointer-events-none` so its empty strip never intercepts clicks on the board
// underneath; each member re-enables pointer events on its own card.
//
// The nav trigger sits INSIDE this region rather than beside it. It has to: this column owns
// the region's z-index, so an outside sibling could only be ordered against the whole column,
// where what is actually needed is for the trigger to stay above the toolbar pill (whose
// max-width reaches the corner on the narrowest viewports) and below a banner that has
// something urgent to say. Both are local orderings, and they only exist here.

// The live-stream state the connection strip renders. Passed down rather than resolved here:
// the page owns the single stream instance, and creating another would open a second socket.
defineProps<{
  connected: boolean
  everConnected: boolean
  connectionFailed: boolean
}>()

const ui = useUiStore()
</script>

<template>
  <div
    class="pointer-events-none absolute inset-x-0 top-0 z-40 flex flex-col items-center gap-2 px-4 pt-3"
  >
    <!-- Compact-viewport nav trigger: the SideBar is an off-canvas drawer below lg, so surface
         a hamburger to open it. Out of the column's flow (it is a corner control, not a
         centered one) and above the toolbar pill it can overlap there. -->
    <UButton
      class="pointer-events-auto absolute start-3 top-3 z-10 lg:hidden"
      icon="i-lucide-menu"
      color="neutral"
      variant="soft"
      size="sm"
      :aria-label="ui.mobileNavOpen ? $t('nav.closeMenu') : $t('nav.openMenu')"
      data-testid="mobile-nav-toggle"
      @click="ui.toggleMobileNav()"
    />

    <!-- FIRST, and deliberately so: the toolbar is standing board chrome, and a tour step
         anchors it. Below the advisories it would move every time one appears or clears. -->
    <BoardToolbar />

    <!-- Then the advisories, most urgent first. Ordering is by what the user loses by not
         reading it now, not by how loud the card is.
         - Connection status: what is on screen right now may already be stale.
         - Spend exceeded: runs are blocked until the budget moves.
         - GitHub PAT (local mode): every repo-operating step will fail.
         - AI readiness: no usable model source, or the default preset names unavailable models.
         - Infrastructure provider: env/runner-pool wired but missing mandatory config.
         - Infra setup: an executor / test env / storage this deployment needs is undefined, so
           a class of agents cannot run.
         - Default test environment: this BOARD has never chosen the provisioning mechanism its
           new services should default to. Last, because it asks for a convenience default and
           so yields to the prompts about things that are outright broken. -->
    <ConnectionStatusBanner
      :connected="connected"
      :ever-connected="everConnected"
      :connection-failed="connectionFailed"
    />
    <SpendWarningBanner />
    <GitHubPatBanner />
    <AiProvidersBanner />
    <ProviderConfigBanner />
    <InfraSetupBanner />
    <DefaultTestEnvBanner />
  </div>
</template>
