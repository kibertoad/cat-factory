<script setup lang="ts">
// The board card for an `initiative`-level block (a frame child, like a module):
// title, the initiative's lifecycle status, and — once a plan is ingested — the
// item-completion progress. Clicking selects the block (the inspector offers
// "Run planning" / "Open tracker"); the tracker button opens the dedicated
// window directly. Draggable within its frame like a task card.
import type { InitiativeStatus } from '~/types/domain'
import { useBlockDrag } from '~/composables/useBlockDrag'

const props = defineProps<{ blockId: string }>()
const board = useBoardStore()
const initiatives = useInitiativesStore()
const ui = useUiStore()
const { t } = useI18n()
const { draggingId, startDrag } = useBlockDrag()

const block = computed(() => board.getBlock(props.blockId))
const initiative = computed(() => initiatives.forBlock(props.blockId))

// Exhaustive (tier-2) status → label-key map: a new InitiativeStatus without a
// label fails the typecheck rather than leaking a raw key into the badge.
const STATUS_LABEL_KEYS: Record<InitiativeStatus, string> = {
  planning: 'initiative.status.planning',
  awaiting_approval: 'initiative.status.awaiting_approval',
  executing: 'initiative.status.executing',
  paused: 'initiative.status.paused',
  done: 'initiative.status.done',
  cancelled: 'initiative.status.cancelled',
}
const STATUS_CHIPS: Record<InitiativeStatus, string> = {
  planning: 'neutral',
  awaiting_approval: 'warning',
  executing: 'info',
  paused: 'neutral',
  done: 'success',
  cancelled: 'neutral',
}
const status = computed<InitiativeStatus>(() => initiative.value?.status ?? 'planning')
const statusLabel = computed(() => t(STATUS_LABEL_KEYS[status.value]))

const progress = computed(() => {
  const items = initiative.value?.items ?? []
  if (items.length === 0) return null
  const settled = items.filter((i) => i.status === 'done' || i.status === 'skipped').length
  return { settled, total: items.length }
})

const selected = computed(() => ui.selectedBlockId === props.blockId)

function select() {
  ui.select(props.blockId)
}
function openTracker() {
  ui.select(props.blockId)
  ui.openInitiativeTracker(props.blockId)
}
function onHandle(e: PointerEvent) {
  if (block.value) startDrag(block.value, e)
}
</script>

<template>
  <div
    v-if="block"
    class="absolute w-[230px]"
    :style="{
      left: block.position.x + 'px',
      top: block.position.y + 'px',
      zIndex: draggingId === blockId ? 60 : 10,
      pointerEvents: draggingId === blockId ? 'none' : undefined,
    }"
  >
    <div
      class="nodrag nopan flex cursor-grab touch-none items-center justify-center rounded-t-lg border border-b-0 border-indigo-800/60 bg-indigo-950/60 py-px active:cursor-grabbing pointer-coarse:py-2"
      :title="t('board.frame.dragTask')"
      @pointerdown="onHandle"
    >
      <UIcon
        name="i-lucide-grip-horizontal"
        class="h-3 w-3 text-indigo-400/60 pointer-coarse:h-5 pointer-coarse:w-5"
      />
    </div>
    <div
      data-testid="initiative-card"
      class="cursor-pointer rounded-b-lg border border-indigo-800/60 bg-indigo-950/40 p-3 transition hover:border-indigo-600"
      :class="selected ? 'ring-2 ring-indigo-400/60' : ''"
      @click.stop="select"
    >
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-milestone" class="h-4 w-4 shrink-0 text-indigo-400" />
          <div class="text-xs font-semibold text-white">{{ block.title }}</div>
        </div>
        <UBadge :color="STATUS_CHIPS[status] as any" variant="subtle" size="sm">
          {{ statusLabel }}
        </UBadge>
      </div>
      <div class="mt-1 text-[10px] uppercase tracking-wide text-indigo-300/70">
        {{ t('initiative.card.kind') }}
      </div>
      <div v-if="progress" class="mt-2 space-y-1">
        <div class="h-1.5 overflow-hidden rounded bg-slate-800">
          <div
            class="h-full rounded bg-indigo-400"
            :style="{ width: `${Math.round((progress.settled / progress.total) * 100)}%` }"
          />
        </div>
        <div class="text-[10px] text-slate-400">
          {{ t('initiative.card.progress', { done: progress.settled, total: progress.total }) }}
        </div>
      </div>
      <UButton
        class="nodrag mt-2"
        data-testid="initiative-open-tracker"
        size="xs"
        variant="soft"
        color="primary"
        icon="i-lucide-list-checks"
        @click.stop="openTracker"
      >
        {{ t('initiative.card.openTracker') }}
      </UButton>
    </div>
  </div>
</template>
