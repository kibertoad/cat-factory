<script setup lang="ts">
import BlockPalette from '~/components/palettes/BlockPalette.vue'
import PipelinePalette from '~/components/palettes/PipelinePalette.vue'
import UserMenu from '~/components/auth/UserMenu.vue'

const confluence = useConfluenceStore()
const ui = useUiStore()

// Resolve whether the Confluence integration is enabled on the backend, so the
// section is hidden entirely when it is off (mirrors how auth gates its UI).
onMounted(() => confluence.probe())
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

    <template v-if="confluence.available">
      <USeparator />
      <section>
        <h2 class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Confluence
        </h2>
        <div class="space-y-1.5">
          <UButton
            block
            color="neutral"
            variant="soft"
            size="sm"
            icon="i-lucide-plug"
            class="justify-start"
            @click="ui.openConfluenceConnect()"
          >
            <span class="truncate">
              {{
                confluence.connected ? confluence.connection?.accountEmail : 'Connect Confluence'
              }}
            </span>
          </UButton>
          <UButton
            v-if="confluence.connected"
            block
            color="neutral"
            variant="soft"
            size="sm"
            icon="i-lucide-file-down"
            class="justify-start"
            @click="ui.openConfluenceImport(null)"
          >
            Import &amp; spawn
          </UButton>
        </div>
      </section>
    </template>

    <UserMenu class="mt-auto" />
  </aside>
</template>
