<script setup lang="ts">
import { computed } from 'vue'
import { columnPct, segmentShares } from './TrendColumn.logic'

// One column of a stacked trend chart. The column stretches to the chart row's height; inside
// it, one stack is sized to the column's total against the tallest column, and the segments
// split that stack by their share. The stack, not each segment, carries the rounded corners,
// so whichever segment is drawn at an edge is rounded.
const props = withDefaults(
  defineProps<{
    /** Top to bottom. A zero value is not drawn. */
    segments: { value: number; class: string }[]
    /** The tallest column's total, which draws at the full row height. */
    max: number
    /** A non-zero column's minimum height, in percent, so a small bucket stays visible. */
    floorPct: number
    /** A 2px separator between drawn segments, taken from inside the lower one. */
    separated?: boolean
    title?: string
  }>(),
  { separated: false, title: undefined },
)

const total = computed(() => props.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0))
const heightPct = computed(() => columnPct(total.value, props.max, props.floorPct))
const drawn = computed(() => segmentShares(props.segments))
</script>

<template>
  <div class="flex flex-1 flex-col justify-end" :title="title">
    <div
      v-if="drawn.length > 0"
      class="flex flex-col overflow-hidden rounded-sm"
      data-testid="trend-stack"
      :style="{ height: `${heightPct}%` }"
    >
      <!-- The separator is padding with the background clipped to the content box, so it sits
      inside the segment's own height and the stack stays to scale. -->
      <div
        v-for="(segment, i) in drawn"
        :key="i"
        :class="[segment.class, separated && i > 0 ? 'bg-clip-content pt-0.5' : '']"
        :style="{ height: `${segment.sharePct}%` }"
      />
    </div>
  </div>
</template>
