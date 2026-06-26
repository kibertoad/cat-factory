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
const ui = useUiStore()

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
  <aside
    class="flex h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-800 bg-slate-900/80 p-3 backdrop-blur"
  >
    <BoardSwitcher />

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
      </div>
    </section>

    <UserMenu class="mt-auto" />
  </aside>
</template>
