<script setup lang="ts">
// The left navbar. The old draggable block/pipeline palettes are gone — blocks
// and pipelines are created through the command bar (⌘K) and the board's own
// affordances. This panel is now navigation + a command-bar launcher: quick
// actions, repository management, integration management, the workspace-wide
// context-fragment library, and workspace configuration (merge thresholds +
// default models).
import BoardSwitcher from '~/components/layout/BoardSwitcher.vue'
import UserMenu from '~/components/auth/UserMenu.vue'

const documents = useDocumentsStore()
const tasks = useTasksStore()
const github = useGitHubStore()
const slack = useSlackStore()
const library = useFragmentLibraryStore()
const workspace = useWorkspaceStore()
const accounts = useAccountsStore()
const ui = useUiStore()

// On compact (< lg) viewports the navbar is an off-canvas drawer. Activating any
// nav control reveals a board-covering panel/modal, so close the drawer on the way
// out — otherwise it lingers in front of (or behind) whatever just opened. Scoped to
// the action sections (not the BoardSwitcher / UserMenu dropdowns at the ends).
function onNavAction(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('button, a')) ui.closeMobileNav()
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
      @click="ui.closeMobileNav()"
    />
  </Transition>

  <aside
    data-testid="sidebar"
    class="fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-800 bg-slate-900/95 p-3 backdrop-blur transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:bg-slate-900/80"
    :class="ui.mobileNavOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'"
  >
    <BoardSwitcher />

    <div class="contents" @click="onNavAction">
      <!-- Command bar launcher (⌘K) — the primary way to create blocks / pipelines
         and reach every action below. -->
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-left text-sm text-slate-400 transition hover:border-slate-500 hover:bg-slate-800"
        @click="ui.openCommandBar()"
      >
        <UIcon name="i-lucide-search" class="h-4 w-4 shrink-0" />
        <span class="flex-1 truncate">Search or run a command…</span>
        <UKbd value="⌘K" />
      </button>

      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Create
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
            Build a pipeline
          </UButton>
        </div>
      </section>

      <USeparator />

      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Repositories
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
            Add from existing repo
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
            Bootstrap repo
          </UButton>
        </div>
      </section>

      <USeparator />

      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Integrations
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
            Integrations
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
            Sandbox
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
            Kaizen
          </UButton>
        </div>
      </section>

      <template v-if="library.available">
        <USeparator />
        <section>
          <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Workspace context
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
            Context fragments
          </UButton>
        </section>
      </template>

      <USeparator />
      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Configuration
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
            Workspace settings
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
            Model Configuration
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
            Account settings
          </UButton>
        </div>
      </section>
    </div>

    <UserMenu class="mt-auto" />
  </aside>
</template>
