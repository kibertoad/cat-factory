<script setup lang="ts">
// The left navbar. The old draggable block/pipeline palettes are gone — blocks
// and pipelines are created through the command bar (⌘K) and the board's own
// affordances. This panel is now navigation + a command-bar launcher: quick
// actions, repository management, integration management, the workspace-wide
// context-fragment library, and workspace configuration (merge thresholds +
// default models).
import { useEventListener, useScrollLock } from '@vueuse/core'
import BoardSwitcher from '~/components/layout/BoardSwitcher.vue'
import LanguageSwitcher from '~/components/layout/LanguageSwitcher.vue'
import UserMenu from '~/components/auth/UserMenu.vue'
import { useViewport } from '~/composables/useViewport'

const { t } = useI18n()

const documents = useDocumentsStore()
const tasks = useTasksStore()
const github = useGitHubStore()
const slack = useSlackStore()
const library = useFragmentLibraryStore()
const workspace = useWorkspaceStore()
const accounts = useAccountsStore()
const auth = useAuthStore()
const providerConnections = useProviderConnectionsStore()
const ui = useUiStore()

// The Infrastructure menu (agent-container execution + test environments) shows whenever the
// deployment reports its infrastructure capability — every facade populates `auth.infrastructure`
// (it drives the execution-backend selector), so there is always an execution + test-env backend
// to view, even on a Worker/Node deployment with no runner-pool/environment connection registered.
// The old provider-availability/local-mode signals stay as a defensive fallback for a backend that
// (somehow) omits the descriptor.
const showInfrastructure = computed(
  () =>
    auth.infrastructure != null ||
    auth.localMode?.enabled === true ||
    providerConnections.isAvailable('runner-pool') ||
    providerConnections.isAvailable('environment'),
)

// `isCompact` (< lg) is the breakpoint at which the navbar is an off-canvas drawer;
// above it the aside is static and the drawer flag is inert.
const { isCompact } = useViewport()

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
    void documents.probe()
    void tasks.probe()
    void github.probe()
    void slack.probe()
    void library.probe()
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
    class="fixed inset-y-0 start-0 z-40 flex h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-e border-slate-800 bg-slate-900/95 p-3 backdrop-blur transition-transform duration-200 focus:outline-none lg:static lg:z-auto lg:translate-x-0 lg:bg-slate-900/80"
    :class="
      ui.mobileNavOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full lg:translate-x-0'
    "
  >
    <BoardSwitcher />

    <div class="contents" @click="onNavAction">
      <!-- Command bar launcher (⌘K) — the primary way to create blocks / pipelines
         and reach every action below. -->
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-start text-sm text-slate-400 transition hover:border-slate-500 hover:bg-slate-800"
        @click="ui.openCommandBar()"
      >
        <UIcon name="i-lucide-search" class="h-4 w-4 shrink-0" />
        <span class="flex-1 truncate">{{ t('nav.commandBar') }}</span>
        <UKbd value="⌘K" />
      </button>

      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('nav.create') }}
        </h2>
        <div class="space-y-1.5">
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-workflow"
            class="justify-start"
            @click="ui.openBuilder()"
          >
            {{ t('nav.buildPipeline') }}
          </UButton>
        </div>
      </section>

      <USeparator />

      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('nav.repositories') }}
        </h2>
        <div class="space-y-1.5">
          <UButton
            v-if="github.available"
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-folder-git-2"
            class="justify-start"
            @click="ui.openAddService()"
          >
            {{ t('nav.addFromRepo') }}
          </UButton>
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-git-branch-plus"
            class="justify-start"
            @click="ui.openBootstrap()"
          >
            {{ t('nav.bootstrapRepo') }}
          </UButton>
        </div>
      </section>

      <USeparator />

      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('nav.integrations') }}
        </h2>
        <div class="space-y-1.5">
          <!-- Every external system the workspace can enable/link now lives behind
             this single button — the hub modal lists them grouped (source control,
             communication, documents, trackers, observability, model providers). -->
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-blocks"
            class="justify-start"
            @click="ui.openIntegrations()"
          >
            {{ t('nav.integrations') }}
          </UButton>
          <!-- The Sandbox: try prompt versions/models against graded fixtures, off to the
             side of the board. Opens the on-demand testing window. -->
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-flask-conical"
            class="justify-start"
            @click="ui.openSandbox()"
          >
            {{ t('nav.sandbox') }}
          </UButton>
          <!-- The Kaizen screen: grading history + verified prompt/agent/model combos. -->
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-sparkles"
            class="justify-start"
            @click="ui.openKaizen()"
          >
            {{ t('nav.kaizen') }}
          </UButton>
        </div>
      </section>

      <template v-if="showInfrastructure">
        <USeparator />
        <section>
          <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('nav.infrastructure') }}
          </h2>
          <div class="space-y-1.5">
            <!-- Where agent containers run + Tester environments + (local mode) the warm
               pool/checkout reuse. Its own top-level destination, no longer inside the
               Integrations hub. -->
            <UButton
              block
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-server-cog"
              class="justify-start"
              data-testid="nav-infrastructure"
              @click="ui.openInfrastructure()"
            >
              {{ t('nav.infrastructure') }}
            </UButton>
          </div>
        </section>
      </template>

      <template v-if="library.available">
        <USeparator />
        <section>
          <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('nav.workspaceContext') }}
          </h2>
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-book-marked"
            class="justify-start"
            @click="ui.openFragmentLibrary()"
          >
            {{ t('nav.contextFragments') }}
          </UButton>
        </section>
      </template>

      <USeparator />
      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('nav.configuration') }}
        </h2>
        <div class="space-y-1.5">
          <!-- Merge thresholds, issue writeback and default service best practices are
             now tabs inside Workspace settings. -->
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-sliders-horizontal"
            class="justify-start"
            @click="ui.openWorkspaceSettings()"
          >
            {{ t('nav.workspaceSettings') }}
          </UButton>
          <UButton
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-cpu"
            class="justify-start"
            @click="ui.openModelConfig()"
          >
            {{ t('nav.modelConfiguration') }}
          </UButton>
          <!-- Account & team: members + roles, invitations, email sender, account API keys.
             Shown once accounts (auth) are enabled. -->
          <UButton
            v-if="accounts.enabled"
            block
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-users"
            class="justify-start"
            @click="ui.openAccountSettings()"
          >
            {{ t('nav.accountSettings') }}
          </UButton>
        </div>
      </section>
    </div>

    <div class="mt-auto space-y-2">
      <LanguageSwitcher />
      <UserMenu />
    </div>
  </aside>
</template>
