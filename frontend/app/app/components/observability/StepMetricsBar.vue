<script setup lang="ts">
import { computed } from 'vue'
import type { StepMetrics } from '~/types/execution'
import {
  formatMs,
  formatTokens,
  headroomColor,
  headroomRatio,
  pct,
  transportRatio,
} from '~/utils/observability'

// Compact, at-a-glance LLM rollup for one pipeline step: token usage, an
// output-limit headroom bar (how close the step ran to truncation), a
// transport-vs-execution latency split, and error/warning badges. Rendered inline
// on the step surfaces (step detail, pipeline timeline). A no-op when there are no
// recorded calls. Clicking anywhere emits `inspect` so a parent can open the
// drill-down panel.
const props = defineProps<{ metrics: StepMetrics; clickable?: boolean }>()
defineEmits<{ inspect: [] }>()

const m = computed(() => props.metrics)
const headroom = computed(() => headroomRatio(m.value))
const transport = computed(() => transportRatio(m.value))
const headroomTone = computed(() => headroomColor(headroom.value, m.value.truncatedCalls > 0))
</script>

<template>
  <div
    v-if="m.calls > 0"
    class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 text-[12px]"
    :class="clickable ? 'cursor-pointer transition hover:border-slate-700 hover:bg-slate-900/70' : ''"
    :role="clickable ? 'button' : undefined"
    @click="clickable ? $emit('inspect') : undefined"
  >
    <!-- header line: call count + tokens + warning/error badges -->
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-activity" class="h-3.5 w-3.5 shrink-0 text-slate-500" />
      <span class="text-slate-300">
        {{ m.calls }} {{ m.calls === 1 ? 'call' : 'calls' }}
      </span>
      <span class="text-slate-500">·</span>
      <span class="tabular-nums text-slate-400" title="Prompt / completion tokens">
        {{ formatTokens(m.promptTokens) }}↑ {{ formatTokens(m.completionTokens) }}↓
      </span>
      <div class="ml-auto flex items-center gap-1">
        <UBadge v-if="m.errors > 0" color="error" variant="subtle" size="sm">
          {{ m.errors }} error{{ m.errors === 1 ? '' : 's' }}
        </UBadge>
        <UBadge v-if="m.warnings > 0" color="warning" variant="subtle" size="sm">
          {{ m.warnings }} warning{{ m.warnings === 1 ? '' : 's' }}
        </UBadge>
        <UIcon
          v-if="clickable"
          name="i-lucide-chevron-right"
          class="h-3.5 w-3.5 text-slate-600"
        />
      </div>
    </div>

    <!-- output-limit headroom -->
    <div v-if="headroom !== null" class="mt-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-slate-500">Output limit</span>
        <span class="tabular-nums" :class="headroomTone">
          {{ formatTokens(m.peakCompletionTokens) }} / {{ formatTokens(m.maxOutputTokens ?? 0) }}
          ({{ pct(headroom) }}%)
        </span>
      </div>
      <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-700/60">
        <div
          class="h-full rounded-full transition-all duration-500"
          :class="
            m.truncatedCalls > 0 || headroom >= 0.98
              ? 'bg-rose-400'
              : headroom >= 0.8
                ? 'bg-amber-400'
                : 'bg-emerald-400'
          "
          :style="{ width: `${Math.max(2, pct(headroom))}%` }"
        />
      </div>
      <p v-if="m.truncatedCalls > 0" class="mt-1 text-[11px] text-rose-400">
        {{ m.truncatedCalls }} call{{ m.truncatedCalls === 1 ? '' : 's' }} truncated at the limit
      </p>
    </div>

    <!-- transport overhead vs model execution -->
    <div v-if="transport !== null" class="mt-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-slate-500">Transport vs execution</span>
        <span class="tabular-nums text-slate-400">
          {{ formatMs(m.overheadMs) }} / {{ formatMs(m.upstreamMs) }}
        </span>
      </div>
      <div class="mt-1 flex h-1 overflow-hidden rounded-full bg-slate-700/60">
        <div
          class="h-full bg-sky-400/80"
          :style="{ width: `${pct(transport)}%` }"
          title="Transport / proxy overhead"
        />
        <div class="h-full bg-indigo-400/80 flex-1" title="Model execution" />
      </div>
    </div>
  </div>
</template>
