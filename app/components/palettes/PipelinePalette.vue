<script setup lang="ts">
import type { Pipeline } from '~/types/domain'
import { AGENT_BY_KIND } from '~/utils/catalog'
import { setDndPayload } from '~/utils/dnd'

const pipelines = usePipelinesStore()
const ui = useUiStore()

function onDragStart(event: DragEvent, pipeline: Pipeline) {
  setDndPayload(event, { kind: 'pipeline', pipelineId: pipeline.id })
  ;(event.target as HTMLElement).classList.add('palette-dragging')
}

function onDragEnd(event: DragEvent) {
  ;(event.target as HTMLElement).classList.remove('palette-dragging')
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between px-1">
      <p class="text-[11px] text-slate-500">Drag a pipeline onto a block to run it.</p>
    </div>

    <UButton
      block
      color="primary"
      variant="soft"
      icon="i-lucide-plus"
      size="sm"
      @click="ui.openBuilder()"
    >
      Build a pipeline
    </UButton>

    <div class="space-y-2">
      <div
        v-for="p in pipelines.pipelines"
        :key="p.id"
        draggable="true"
        class="group cursor-grab select-none rounded-lg border border-slate-700 bg-slate-800/60 p-2.5 transition hover:border-indigo-500/70 hover:bg-slate-800 active:cursor-grabbing"
        @dragstart="onDragStart($event, p)"
        @dragend="onDragEnd"
      >
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-semibold text-slate-100">{{ p.name }}</span>
          <UButton
            icon="i-lucide-trash-2"
            color="neutral"
            variant="ghost"
            size="xs"
            class="opacity-0 transition group-hover:opacity-100"
            @click.stop="pipelines.removePipeline(p.id)"
          />
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <template v-for="(k, i) in p.agentKinds" :key="i">
            <UIcon
              :name="AGENT_BY_KIND[k].icon"
              class="h-4 w-4"
              :style="{ color: AGENT_BY_KIND[k].color }"
              :title="AGENT_BY_KIND[k].label"
            />
            <UIcon
              v-if="i < p.agentKinds.length - 1"
              name="i-lucide-chevron-right"
              class="h-3 w-3 text-slate-600"
            />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
