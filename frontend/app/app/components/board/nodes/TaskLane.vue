<script setup lang="ts">
import LaneGroup from './LaneGroup.vue'
import { LANE_GEOMETRY } from '~/utils/laneGeometry'
import type { LaneGroupKey } from '~/utils/laneSort'
import { LANE_META, type TaskLane } from '~/utils/swimlanes'

/**
 * One status lane inside a service frame.
 *
 * The lane BODY is the frame's drop zone, so a card dropped into any of another frame's lanes
 * moves to that service. Which lane it lands in is not a choice a drop can make: the lane is
 * derived from the task's state, so dropping a not-started card on "In progress" would have to
 * either lie or silently ignore the gesture. Reparenting is the one thing a drag decides.
 *
 * The body SCROLLS rather than growing. A lane is a fixed viewport onto an unbounded list, which
 * is what keeps a busy service's frame the same size as a quiet one's.
 */
const props = defineProps<{
  lane: TaskLane
  groups: LaneGroup[]
  /** Every task in this lane, before any cap. The header states this, not what it rendered. */
  total: number
  groupKey: LaneGroupKey
  frameId: string
}>()

const { t } = useI18n()
const meta = computed(() => LANE_META[props.lane])
const isEmpty = computed(() => props.groups.every((g) => g.entries.length === 0))
</script>

<template>
  <div
    class="flex min-w-0 flex-col rounded-lg bg-slate-900/40"
    :style="{ width: LANE_GEOMETRY.laneWidth + 'px' }"
    :data-lane="lane"
  >
    <!-- Lane header -->
    <div
      class="flex items-center gap-1.5 rounded-t-lg border-b px-2 py-1.5"
      :style="{ borderColor: meta.color + '33' }"
    >
      <UIcon :name="meta.icon" class="h-3.5 w-3.5 shrink-0" :style="{ color: meta.color }" />
      <span class="truncate text-[11px] font-semibold text-slate-200">{{ t(meta.labelKey) }}</span>
      <span
        class="ms-auto shrink-0 rounded px-1 text-[10px] font-semibold tabular-nums"
        :style="{ backgroundColor: meta.color + '22', color: meta.color }"
        :data-testid="`lane-count-${lane}`"
        >{{ total }}</span
      >
    </div>

    <!-- Lane body: the frame's drop zone, and the scroll viewport. -->
    <div
      :data-drop-zone="frameId"
      :data-testid="`lane-${lane}`"
      class="nodrag flex-1 space-y-2 overflow-y-auto overflow-x-hidden p-2"
      :style="{ height: LANE_GEOMETRY.laneBodyHeight + 'px' }"
    >
      <!-- An empty lane SAYS it is empty. Left blank, "nothing needs you" and "the lane failed
           to render" look identical, and the first is worth stating: it is the answer a reader
           scanning the needs-you column is hoping for. -->
      <p v-if="isEmpty" class="px-1 pt-2 text-[10px] leading-snug text-slate-600">
        {{ t(meta.emptyKey) }}
      </p>
      <LaneGroup
        v-for="(group, i) in groups"
        v-else
        :key="group.label ?? `catch-all-${i}`"
        :group="group"
        :group-key="groupKey"
        :frame-id="frameId"
      />
    </div>
  </div>
</template>
