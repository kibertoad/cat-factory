<script setup lang="ts">
import BlockPalette from '~/components/palettes/BlockPalette.vue'
import PipelinePalette from '~/components/palettes/PipelinePalette.vue'
import UserMenu from '~/components/auth/UserMenu.vue'
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

    <UserMenu class="mt-auto" />
  </aside>
</template>
