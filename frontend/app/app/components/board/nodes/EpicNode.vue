<script setup lang="ts">
import { computed } from 'vue'
import type { Block } from '~/types/domain'

// Vue Flow passes the node's `id` as a prop. An epic is a NON-structural grouping node:
// it has no children of its own (tasks join it via their `epicId`), so it renders as a
// compact card showing the epic title + a roll-up of its member tasks. The dependency-edge
// overlay draws the links from this card to each member (anchored by `data-block-id`).
const props = defineProps<{ id: string }>()

const board = useBoardStore()
const ui = useUiStore()
const { t } = useI18n()

const block = computed<Block | undefined>(() => board.getBlock(props.id))
const members = computed(() => board.epicMembers(props.id))
const total = computed(() => members.value.length)
const done = computed(() => members.value.filter((m) => m.status === 'done').length)
const active = computed(
  () => members.value.filter((m) => m.status === 'in_progress' || m.status === 'pr_ready').length,
)
const selected = computed(() => ui.selectedBlockId === props.id)
</script>

<template>
  <div
    v-if="block"
    :data-block-id="block.id"
    class="w-56 cursor-pointer rounded-lg border bg-slate-900/90 px-3 py-2 shadow-lg backdrop-blur transition-colors"
    :class="selected ? 'border-violet-400 ring-1 ring-violet-400/50' : 'border-violet-500/40'"
    @click="ui.select(block.id)"
  >
    <div class="flex items-center gap-1.5">
      <UIcon name="i-lucide-layers" class="h-3.5 w-3.5 shrink-0 text-violet-400" />
      <span class="text-[10px] font-semibold uppercase tracking-wide text-violet-300">{{
        t('board.epic.label')
      }}</span>
      <span class="ms-auto text-[10px] text-slate-400">{{ done }}/{{ total }}</span>
    </div>
    <div class="mt-1 truncate text-sm font-medium text-slate-100" :title="block.title">
      {{ block.title }}
    </div>
    <div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-700/60">
      <div
        class="h-full rounded-full bg-violet-500"
        :style="{ width: total ? `${Math.round((done / total) * 100)}%` : '0%' }"
      />
    </div>
    <div v-if="active" class="mt-1 text-[10px] text-slate-400">
      {{ t('board.epic.activeCount', { count: active }) }}
    </div>
    <div v-else-if="total === 0" class="mt-1 text-[10px] text-slate-500">
      {{ t('board.epic.noTasksYet') }}
    </div>
  </div>
</template>
