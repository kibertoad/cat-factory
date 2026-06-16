<script setup lang="ts">
import BlockPalette from '~/components/palettes/BlockPalette.vue'
import PipelinePalette from '~/components/palettes/PipelinePalette.vue'
import BoardSwitcher from '~/components/layout/BoardSwitcher.vue'
import UserMenu from '~/components/auth/UserMenu.vue'

const documents = useDocumentsStore()
const tasks = useTasksStore()
const github = useGitHubStore()
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

    <USeparator />

    <section>
      <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Building blocks
      </h2>
      <BlockPalette />
    </section>

    <USeparator />

    <section>
      <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Pipelines
      </h2>
      <PipelinePalette />
    </section>

    <USeparator />
    <section>
      <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Repositories
      </h2>
      <UButton
        block
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-lucide-git-branch-plus"
        class="justify-start"
        @click="ui.openBootstrap()"
      >
        Bootstrap repo
      </UButton>
    </section>

    <template v-if="library.available">
      <USeparator />
      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Prompt library
        </h2>
        <UButton
          block
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-book-marked"
          class="justify-start"
          @click="ui.openFragmentLibrary()"
        >
          Best-practice fragments
        </UButton>
      </section>
    </template>

    <template v-if="github.available">
      <USeparator />
      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          GitHub
        </h2>
        <UButton
          block
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-github"
          class="justify-start"
          @click="ui.openGitHub()"
        >
          <span class="truncate">
            {{ github.connected ? github.connection?.accountLogin : 'Connect GitHub' }}
          </span>
        </UButton>
      </section>
    </template>

    <template v-if="documents.available && documents.sources.length">
      <USeparator />
      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Document sources
        </h2>
        <div class="space-y-1.5">
          <UButton
            v-for="src in documents.sources"
            :key="src.source"
            block
            color="neutral"
            variant="soft"
            size="sm"
            :icon="src.icon"
            class="justify-start"
            @click="ui.openDocumentConnect(src.source)"
          >
            <span class="truncate">
              {{ documents.isConnected(src.source) ? src.label : `Connect ${src.label}` }}
            </span>
          </UButton>
          <UButton
            v-if="documents.anyConnected"
            block
            color="neutral"
            variant="soft"
            size="sm"
            icon="i-lucide-file-down"
            class="justify-start"
            @click="ui.openDocumentImport(null)"
          >
            Import &amp; spawn
          </UButton>
        </div>
      </section>
    </template>

    <template v-if="tasks.available && tasks.sources.length">
      <USeparator />
      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Task sources
        </h2>
        <div class="space-y-1.5">
          <UButton
            v-for="src in tasks.sources"
            :key="src.source"
            block
            color="neutral"
            variant="soft"
            size="sm"
            :icon="src.icon"
            class="justify-start"
            @click="ui.openTaskConnect(src.source)"
          >
            <span class="truncate">
              {{ tasks.isConnected(src.source) ? src.label : `Connect ${src.label}` }}
            </span>
          </UButton>
          <UButton
            v-if="tasks.anyConnected"
            block
            color="neutral"
            variant="soft"
            size="sm"
            icon="i-lucide-file-down"
            class="justify-start"
            @click="ui.openTaskImport(null)"
          >
            Import issues
          </UButton>
        </div>
      </section>
    </template>

    <UserMenu class="mt-auto" />
  </aside>
</template>
