<script setup lang="ts">
import { computed } from 'vue'
import type { StepMetrics } from '~/types/execution'
import {
  formatCost,
  formatMs,
  formatTokens,
  headroomColor,
  headroomRatio,
  pct,
  totalInputTokens,
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

const { t } = useI18n()

const m = computed(() => props.metrics)
// The headline "↑" is TOTAL input — fresh + both cache classes — the like-for-like measure of
// Claude Code's own context gauge, which counts the same buckets because a cached token still
// occupies the context window (see `totalInputTokens`). The three classes then render as the
// breakdown, because they are priced an order of magnitude apart in opposite directions: a read
// is ~0.1x base input, a write 1.25-2x. Volume in the headline, cost in the breakdown — leading
// with fresh made a 31M-token run read as a 685-token one.
const totalInput = computed(() => totalInputTokens(m.value))
const cacheRead = computed(() => m.value.cacheReadTokens ?? 0)
const cacheWrite = computed(() => m.value.cacheWriteTokens ?? 0)
const hasCache = computed(() => cacheRead.value > 0 || cacheWrite.value > 0)
// Money beside the volume, not instead of it. Null when the deployment prices nothing or has
// no rate for the model that ran — the figure is then OMITTED rather than shown as 0.00, which
// would claim the step was free.
const cost = computed(() => formatCost(m.value.costEstimate, m.value.costCurrency))
const headroom = computed(() => headroomRatio(m.value))
const transport = computed(() => transportRatio(m.value))
const headroomTone = computed(() => headroomColor(headroom.value, m.value.truncatedCalls > 0))
</script>

<template>
  <div
    v-if="m.calls > 0"
    class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 text-[12px]"
    :class="
      clickable ? 'cursor-pointer transition hover:border-slate-700 hover:bg-slate-900/70' : ''
    "
    :role="clickable ? 'button' : undefined"
    @click="clickable ? $emit('inspect') : undefined"
  >
    <!-- header line: call count + tokens + warning/error badges -->
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-activity" class="h-3.5 w-3.5 shrink-0 text-slate-500" />
      <span class="text-slate-300">
        {{ t('observability.metricsBar.calls', { count: m.calls }, m.calls) }}
      </span>
      <span class="text-slate-500">·</span>
      <span
        class="tabular-nums text-slate-400"
        :title="t('observability.metricsBar.inputCompletionTokens')"
      >
        {{ formatTokens(totalInput) }}↑ {{ formatTokens(m.completionTokens) }}↓
      </span>
      <template v-if="cost">
        <span class="text-slate-500">·</span>
        <span class="tabular-nums text-slate-300" :title="t('observability.metricsBar.costHint')">
          {{ cost }}
        </span>
      </template>
      <div class="ms-auto flex items-center gap-1">
        <UBadge v-if="m.errors > 0" color="error" variant="subtle" size="sm">
          {{ t('observability.metricsBar.errors', { count: m.errors }, m.errors) }}
        </UBadge>
        <UBadge v-if="m.warnings > 0" color="warning" variant="subtle" size="sm">
          {{ t('observability.metricsBar.warnings', { count: m.warnings }, m.warnings) }}
        </UBadge>
        <UIcon
          v-if="clickable"
          name="i-lucide-chevron-right"
          class="h-3.5 w-3.5 text-slate-600 rtl:-scale-x-100"
        />
      </div>
    </div>

    <!-- input breakdown: the headline's three classes, priced an order of magnitude apart -->
    <div v-if="hasCache" class="mt-1.5 flex items-center gap-1.5 text-[11px] tabular-nums">
      <span class="text-slate-400" :title="t('observability.metricsBar.freshHint')">
        {{ t('observability.metricsBar.fresh', { tokens: formatTokens(m.promptTokens) }) }}
      </span>
      <span v-if="cacheRead > 0" class="text-slate-600">·</span>
      <span
        v-if="cacheRead > 0"
        class="text-emerald-400/80"
        :title="t('observability.metricsBar.cacheReadHint')"
      >
        {{ t('observability.metricsBar.cacheRead', { tokens: formatTokens(cacheRead) }) }}
      </span>
      <span v-if="cacheWrite > 0" class="text-slate-600">·</span>
      <span
        v-if="cacheWrite > 0"
        class="text-amber-400/80"
        :title="t('observability.metricsBar.cacheWriteHint')"
      >
        {{ t('observability.metricsBar.cacheWrite', { tokens: formatTokens(cacheWrite) }) }}
      </span>
    </div>

    <!-- output-limit headroom -->
    <div v-if="headroom !== null" class="mt-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-slate-500">{{ t('observability.metricsBar.outputLimit') }}</span>
        <span class="tabular-nums" :class="headroomTone">
          {{ formatTokens(m.peakCompletionTokens) }} /
          {{ formatTokens(m.maxOutputTokens ?? 0) }} ({{ pct(headroom) }}%)
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
        {{
          t(
            'observability.metricsBar.truncatedCalls',
            { count: m.truncatedCalls },
            m.truncatedCalls,
          )
        }}
      </p>
    </div>

    <!-- transport overhead vs model execution -->
    <div v-if="transport !== null" class="mt-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-slate-500">{{ t('observability.metricsBar.transportVsExecution') }}</span>
        <span class="tabular-nums text-slate-400">
          {{ formatMs(m.overheadMs) }} / {{ formatMs(m.upstreamMs) }}
        </span>
      </div>
      <div class="mt-1 flex h-1 overflow-hidden rounded-full bg-slate-700/60">
        <div
          class="h-full bg-sky-400/80"
          :style="{ width: `${pct(transport)}%` }"
          :title="t('observability.metricsBar.transportOverhead')"
        />
        <div
          class="h-full bg-indigo-400/80 flex-1"
          :title="t('observability.metricsBar.modelExecution')"
        />
      </div>
    </div>
  </div>
</template>
