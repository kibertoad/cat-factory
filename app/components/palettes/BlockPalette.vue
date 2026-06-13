<script setup lang="ts">
import type { BlockType } from '~/types/domain'
import { BLOCK_TYPE_META } from '~/utils/catalog'
import { setDndPayload } from '~/utils/dnd'

const types = Object.keys(BLOCK_TYPE_META) as BlockType[]

function onDragStart(event: DragEvent, blockType: BlockType) {
  setDndPayload(event, { kind: 'block', blockType })
  ;(event.target as HTMLElement).classList.add('palette-dragging')
}

function onDragEnd(event: DragEvent) {
  ;(event.target as HTMLElement).classList.remove('palette-dragging')
}
</script>

<template>
  <div class="space-y-2">
    <p class="px-1 text-[11px] text-slate-500">Drag a block onto the board.</p>
    <div class="grid grid-cols-2 gap-2">
      <div
        v-for="t in types"
        :key="t"
        draggable="true"
        class="flex cursor-grab select-none flex-col items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 p-2.5 transition hover:border-slate-500 hover:bg-slate-800 active:cursor-grabbing"
        @dragstart="onDragStart($event, t)"
        @dragend="onDragEnd"
      >
        <UIcon
          :name="BLOCK_TYPE_META[t].icon"
          class="h-5 w-5"
          :style="{ color: BLOCK_TYPE_META[t].accent }"
        />
        <span class="text-[11px] font-medium text-slate-200">
          {{ BLOCK_TYPE_META[t].label }}
        </span>
      </div>
    </div>
  </div>
</template>
