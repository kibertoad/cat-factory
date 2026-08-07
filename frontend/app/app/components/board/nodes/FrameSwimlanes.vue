<script setup lang="ts">
import LaneGroup from './LaneGroup.vue'
import TaskLane from './TaskLane.vue'
import { useFrameLanes } from '~/composables/useFrameLanes'
import { LANE_GEOMETRY } from '~/utils/laneGeometry'
import { LANE_META } from '~/utils/swimlanes'

/**
 * A service frame's tasks, laid out in status lanes.
 *
 * Three live lanes side by side, then the Done lane as a full-width strip beneath them rather
 * than a fourth column. A collapsed column cannot state its own count without turning its label
 * sideways, and giving the archive a quarter of the width permanently would take it from the
 * three lanes a reader actually works in. As a strip it is one row when shut and a wide grid when
 * opened, which is also the better shape for scanning history.
 */
const props = defineProps<{
  frameId: string
  /** A live lane's scroll viewport, resolved by the frame from its own size. */
  laneBodyHeight: number
}>()

const { t } = useI18n()
const laneView = useLaneViewStore()
const { lanes, doneSelection } = useFrameLanes(computed(() => props.frameId))

const liveLanes = computed(() => lanes.value.filter((l) => l.lane !== 'done'))
const doneLane = computed(() => lanes.value.find((l) => l.lane === 'done'))

/**
 * What the Done lane is holding back, as one line.
 *
 * The two counts are reported separately because they tell a reader different things: an age
 * drop means "there is older history, look further back", a cap drop means "there is more from
 * this same period". Reporting nothing at all would be the worse failure — a truncated archive
 * would read exactly like a complete one.
 */
const withheldNote = computed(() => {
  const { hiddenByAge, hiddenByCap, undatedShown } = doneSelection.value
  const parts: string[] = []
  if (hiddenByCap > 0) parts.push(t('board.lanes.done.hiddenByCap', { count: hiddenByCap }))
  if (hiddenByAge > 0) parts.push(t('board.lanes.done.hiddenByAge', { count: hiddenByAge }))
  // Blocks merged before completion dates were recorded have no honest age, so the age cap
  // cannot apply to them. Saying so stops the window looking tighter than it is.
  if (undatedShown > 0 && hiddenByAge > 0) {
    parts.push(t('board.lanes.done.undated', { count: undatedShown }))
  }
  return parts.join(' · ')
})
</script>

<template>
  <div class="space-y-2">
    <!-- The three lanes a reader works in -->
    <div class="flex items-start" :style="{ gap: LANE_GEOMETRY.laneGap + 'px' }">
      <TaskLane
        v-for="rendered in liveLanes"
        :key="rendered.lane"
        :rendered="rendered"
        :group-key="laneView.groupKey"
        :frame-id="frameId"
        :body-height="laneBodyHeight"
      />
    </div>

    <!-- The Done strip. Rendered only once the service HAS finished something: an empty archive
         is the one lane whose emptiness says nothing a reader needs (a new service has merged
         nothing, which its three live lanes already show). -->
    <div v-if="doneLane && doneLane.total > 0" class="rounded-lg bg-slate-900/40">
      <button
        type="button"
        class="nodrag flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-slate-800/40"
        data-testid="done-lane-toggle"
        :aria-expanded="!laneView.doneLaneCollapsed"
        @click.stop="laneView.toggleDoneLane()"
      >
        <UIcon
          :name="laneView.doneLaneCollapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
          class="h-3.5 w-3.5 shrink-0 text-slate-500"
        />
        <UIcon
          :name="LANE_META.done.icon"
          class="h-3.5 w-3.5 shrink-0"
          :style="{ color: LANE_META.done.color }"
        />
        <span class="text-[11px] font-semibold text-slate-200">{{
          t(LANE_META.done.labelKey)
        }}</span>
        <!-- The TOTAL, not what the caps admitted: "this service has finished 312 tasks" is the
             fact the lane carries, and counting only the visible cards would understate it by
             two orders of magnitude. -->
        <span
          class="shrink-0 rounded px-1 text-[10px] font-semibold tabular-nums"
          :style="{
            backgroundColor: LANE_META.done.color + '22',
            color: LANE_META.done.color,
          }"
          data-testid="lane-count-done"
          >{{ doneLane.total }}</span
        >
        <span v-if="withheldNote" class="ms-auto truncate text-[10px] text-slate-500">{{
          withheldNote
        }}</span>
      </button>

      <!-- The archive opens as a WIDE GRID: each group takes the strip's full width and wraps its
           own cards across it, and the groups stack. Wrapping the GROUPS instead read correctly
           only when there were several of them — under the default `none` grouping a lane is
           exactly one group, so the whole archive rendered as a single card-wide column down the
           left of an otherwise empty strip. -->
      <div
        v-if="!laneView.doneLaneCollapsed"
        :data-drop-zone="frameId"
        data-testid="lane-done"
        data-lane="done"
        class="nodrag space-y-2 overflow-y-auto p-2 pt-0"
        :style="{ maxHeight: laneBodyHeight + 'px' }"
      >
        <!-- A zero cap is a real setting ("count them, show none"), so the strip explains why it
             has nothing in it rather than looking broken. -->
        <p
          v-if="doneSelection.shown.length === 0"
          class="px-1 text-[10px] leading-snug text-slate-600"
        >
          {{ t('board.lanes.done.allWithheld') }}
        </p>
        <LaneGroup
          v-for="(group, i) in doneLane.groups"
          v-else
          :key="group.label ?? `catch-all-${i}`"
          :group="group"
          :group-key="laneView.groupKey"
          :frame-id="frameId"
          layout="grid"
        />
      </div>
    </div>
  </div>
</template>
