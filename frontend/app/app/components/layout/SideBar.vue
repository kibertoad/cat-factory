<script setup lang="ts">
// The left navbar. The old draggable block/pipeline palettes are gone — blocks
// and pipelines are created through the command bar (⌘K) and the board's own
// affordances. This panel is now navigation + a command-bar launcher: quick
// actions, repository management, integration management, the workspace-wide
// context-fragment library, and workspace configuration (merge thresholds +
// default models).
//
// Two orthogonal ways this panel shrinks. WHICH destinations exist is the interface
// TIER (basic hides the `advanced` contributions, filtered upstream in `navSlotFilter`);
// how much room they take is the COLLAPSE state (the icon-only rail). Basic mode starts
// railed, but either can be changed independently from the tier switcher at the top /
// the rail toggle.
import { useEventListener, useScrollLock } from '@vueuse/core'
import BoardSwitcher from '~/components/layout/BoardSwitcher.vue'
import LanguageSwitcher from '~/components/layout/LanguageSwitcher.vue'
import UiModeSwitcher from '~/components/layout/UiModeSwitcher.vue'
import UserMenu from '~/components/auth/UserMenu.vue'
import { useViewport } from '~/composables/useViewport'
import type { NavContribution } from '~/modular/nav-contributions'

const { t } = useI18n()

const documents = useDocumentsStore()
const tasks = useTasksStore()
const github = useGitHubStore()
const slack = useSlackStore()
const library = useFragmentLibraryStore()
const workspace = useWorkspaceStore()
const providerConnections = useProviderConnectionsStore()
const ui = useUiStore()

// The nav catalog + its reactive RBAC/availability gating now lives in the shared
// modular-vue manifest (backend/docs/adr/0049-modular-vue-adoption.md, slice 1): every
// destination is declared once in `nav-contributions.ts`, gated by `navSlotFilter`
// over a reactive `gates` service, and rendered here (and in CommandBar / BoardToolbar)
// from `useReactiveSlots`. Sections + items appear/disappear reactively as a permission
// or connection flips, so this shell no longer hand-rolls per-item `show*` computeds.
const { sidebarGroups, invoke } = useNavContributions()

/**
 * A destination's visible label: catalog copy for a first-party item, the LITERAL `label` for
 * one whose copy is deployment data (a registered external tool's title). A tool's name is not
 * a catalog key — the deployment ships whatever locales it needs in its own catalog — so
 * running it through `t()` would render the raw name back with a missing-key warning.
 */
function navLabel(item: NavContribution): string {
  return item.label ?? t(item.labelKey)
}

/**
 * The hover tooltip. In the rail it names the destination (the label is hidden); expanded it
 * carries the item's `description` when it has one, which is how an external tool explains
 * what it is without a second line in the sidebar.
 */
function navTitle(item: NavContribution, railed: boolean): string | undefined {
  if (railed) return item.description ? `${navLabel(item)}: ${item.description}` : navLabel(item)
  return item.description
}

// `isCompact` (< lg) is the breakpoint at which the navbar is an off-canvas drawer;
// above it the aside is static and the drawer flag is inert.
const { isCompact } = useViewport()

// The collapsed RAIL: labels drop away and the aside narrows to its icons. Scoped to the
// STATIC aside — an off-canvas drawer is already a deliberate, temporary reveal, so opening
// it only to find a rail would be two taps for one destination. The tier decides the default
// (basic starts collapsed), the user's toggle wins from there — see `stores/uiMode.ts`.
const uiMode = useUiModeStore()
const railed = computed(() => !isCompact.value && uiMode.navCollapsed)

// The off-canvas drawer is a modal surface on compact viewports, so give it the
// expected affordances:
//   • Escape closes it (keyboard parity with the backdrop tap),
//   • body scroll is locked while it's open (defensive — the shell root is already
//     `overflow-hidden`, so this just guards any future scrollable ancestor),
//   • crossing back to lg+ clears the flag so it can't linger as stale open state,
//   • focus moves into the drawer on open, and back to the hamburger on close,
//   • when closed (off-screen) on compact the whole aside is `inert`, so its nav
//     controls aren't reachable by keyboard / assistive tech behind the board.
const aside = ref<HTMLElement>()
const drawerOpen = computed(() => isCompact.value && ui.mobileNavOpen)

const bodyLocked = useScrollLock(import.meta.client ? document.body : null)
watchEffect(() => {
  bodyLocked.value = drawerOpen.value
})

useEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && ui.mobileNavOpen) ui.closeMobileNav()
})

watch(isCompact, (compact) => {
  if (!compact) ui.closeMobileNav()
})

// Closing via a nav action immediately opens a board-covering panel/modal that claims
// focus itself, so don't yank focus back to the hamburger in that case.
let suppressFocusRestore = false
watch(drawerOpen, (open) => {
  if (open) {
    suppressFocusRestore = false
    void nextTick(() => aside.value?.focus())
  } else if (isCompact.value && !suppressFocusRestore) {
    void nextTick(() =>
      document.querySelector<HTMLElement>('[data-testid="mobile-nav-toggle"]')?.focus(),
    )
  }
})

// On compact (< lg) viewports the navbar is an off-canvas drawer. Activating any
// nav control reveals a board-covering panel/modal, so close the drawer on the way
// out — otherwise it lingers in front of (or behind) whatever just opened. Scoped to
// the action sections (not the BoardSwitcher / UserMenu dropdowns at the ends).
function onNavAction(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('button, a')) {
    suppressFocusRestore = true
    ui.closeMobileNav()
  }
}

// Resolve whether the document-source / task-source / GitHub integrations are
// enabled on the backend, so each section is hidden entirely when it is off
// (mirrors how auth gates its UI). A 503 from a probe flips its `available` to
// false. Re-probe whenever the active board changes — connections are per board.
watch(
  () => workspace.workspaceId,
  (id) => {
    if (!id) return
    // `ensureProbed` single-flights per board (app-startup initiative, item 12): on a cold open
    // these coalesce with the board page's own github probe and don't refire on a re-mount, while a
    // workspace switch (new id) still re-probes. `probe()` stays the explicit post-connect refresh.
    void documents.ensureProbed()
    void tasks.ensureProbed()
    void github.ensureProbed()
    void slack.ensureProbed()
    void library.ensureProbed()
    void providerConnections.ensureLoaded().catch(() => {})
  },
  { immediate: true },
)
</script>

<template>
  <!-- On < lg the navbar slides in over the board; this backdrop dims the board and
       closes the drawer on tap. Hidden on lg+ where the navbar is a static aside. -->
  <Transition
    enter-active-class="transition-opacity duration-200"
    leave-active-class="transition-opacity duration-200"
    enter-from-class="opacity-0"
    leave-to-class="opacity-0"
  >
    <div
      v-if="ui.mobileNavOpen"
      class="fixed inset-0 z-30 bg-slate-950/60 backdrop-blur-sm lg:hidden"
      data-testid="sidebar-backdrop"
      role="button"
      tabindex="-1"
      :aria-label="t('common.close')"
      @click="ui.closeMobileNav()"
    />
  </Transition>

  <aside
    ref="aside"
    data-testid="sidebar"
    tabindex="-1"
    :role="drawerOpen ? 'dialog' : undefined"
    :aria-modal="drawerOpen ? 'true' : undefined"
    :aria-label="isCompact ? t('nav.menu') : undefined"
    :inert="isCompact && !ui.mobileNavOpen"
    class="fixed inset-y-0 start-0 z-40 flex h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-e border-slate-800 bg-slate-900/95 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur transition-transform duration-200 focus:outline-none lg:static lg:z-auto lg:translate-x-0 lg:bg-slate-900/80"
    :class="[
      ui.mobileNavOpen
        ? 'translate-x-0'
        : '-translate-x-full rtl:translate-x-full lg:translate-x-0',
      // The rail is lg-only (see `railed`), so the narrow width is too — below lg the drawer
      // keeps its full width whatever the collapse state says.
      railed ? 'lg:w-14 lg:px-2' : '',
    ]"
    :data-collapsed="railed ? 'true' : 'false'"
  >
    <!-- Rail toggle. lg-only: below it the hamburger + backdrop already own showing and
         hiding the whole navbar, and a second collapse control there would fight them. -->
    <!-- The panel glyphs are drawn for a left-hand navbar; under RTL the aside is `start`-anchored
         to the right, so mirror them like the other directional icons in the SPA. -->
    <UButton
      class="hidden shrink-0 lg:flex"
      :class="railed ? 'justify-center' : 'justify-end'"
      :ui="{ leadingIcon: 'rtl:-scale-x-100' }"
      :icon="railed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="railed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
      :title="railed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
      :aria-expanded="!railed"
      data-testid="sidebar-collapse-toggle"
      @click="uiMode.toggleNav()"
    />

    <BoardSwitcher :collapsed="railed" />

    <!-- The interface tier sits ABOVE the destinations it gates, not in the footer: basic is the
         shipped default, so this row is most users' only sight of the tier, and below the fold in
         a scrolled navbar it is a thin thread to hang the advanced half of the product on. The
         wrapper is what keeps the control and its hint together — the aside's own `gap-4` would
         otherwise push them apart. Kept OUT of the `onNavAction` group deliberately: switching
         tiers opens nothing, and closing the compact drawer would hide the destinations the
         switch just revealed. -->
    <div class="space-y-1">
      <UiModeSwitcher :collapsed="railed" />
    </div>

    <div class="contents" @click="onNavAction">
      <!-- Command bar launcher (⌘K) — the primary way to create blocks / pipelines
         and reach every action below. -->
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 py-2 text-start text-sm text-slate-400 transition hover:border-slate-500 hover:bg-slate-800"
        :class="railed ? 'justify-center px-0' : 'px-2.5'"
        :aria-label="t('nav.commandBar')"
        :title="railed ? t('nav.commandBar') : undefined"
        data-testid="command-bar-launcher"
        @click="ui.openCommandBar()"
      >
        <UIcon name="i-lucide-search" class="h-4 w-4 shrink-0" />
        <span v-if="!railed" class="flex-1 truncate">{{ t('nav.commandBar') }}</span>
        <UKbd v-if="!railed" value="⌘K" />
      </button>

      <!-- Sections + items come from the shared nav manifest, already gated by the
         reactive slotFilter (backend/docs/adr/0049-modular-vue-adoption.md, slice 1) — which
         also drops the `advanced` items in basic interface mode. An empty section is
         dropped upstream, so there is no per-section `v-if` here.
         In the rail the section HEADERS go (they'd wrap to nothing at 3.5rem) but the
         separators stay, so the grouping is still legible as icon clusters. -->
      <template v-for="section in sidebarGroups" :key="section.group">
        <USeparator />
        <section>
          <h2
            v-if="!railed"
            class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            {{ t(section.labelKey) }}
          </h2>
          <div class="space-y-1.5">
            <UButton
              v-for="item in section.items"
              :key="item.id"
              :block="!railed"
              color="primary"
              variant="soft"
              size="sm"
              :icon="item.icon"
              :square="railed"
              class="w-full"
              :class="railed ? 'justify-center' : 'justify-start'"
              :aria-label="railed ? navLabel(item) : undefined"
              :title="navTitle(item, railed)"
              :data-testid="item.testId"
              @click="invoke(item)"
            >
              <span v-if="!railed">{{ navLabel(item) }}</span>
            </UButton>
          </div>
        </section>
      </template>
    </div>

    <div class="mt-auto space-y-2">
      <LanguageSwitcher :collapsed="railed" />
      <UserMenu :collapsed="railed" />
    </div>
  </aside>
</template>
