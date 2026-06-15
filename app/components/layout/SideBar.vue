<script setup lang="ts">
import BlockPalette from '~/components/palettes/BlockPalette.vue'
import PipelinePalette from '~/components/palettes/PipelinePalette.vue'
import UserMenu from '~/components/auth/UserMenu.vue'

const documents = useDocumentsStore()
const github = useGitHubStore()
const ui = useUiStore()

// Resolve whether the document-source / GitHub integrations are enabled on the
// backend, so each section is hidden entirely when it is off (mirrors how auth
// gates its UI). A 503 from either probe flips its `available` to false.
onMounted(() => {
  void documents.probe()
  void github.probe()
})
</script>

<template>
  <aside
    class="flex h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-800 bg-slate-900/80 p-3 backdrop-blur"
  >
    <div class="flex items-center gap-2 px-1">
      <UIcon name="i-lucide-layout-dashboard" class="h-5 w-5 text-indigo-400" />
      <div>
        <div class="text-sm font-semibold text-white">Architecture Board</div>
        <div class="text-[10px] text-slate-500">agent visualization prototype</div>
      </div>
    </div>

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

    <UserMenu class="mt-auto" />
  </aside>
</template>
