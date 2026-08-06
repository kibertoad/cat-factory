<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { AgentToolCall, RunToolCallFailures, RunToolCallTrajectory } from '~/types/execution'
import type { ToolOutcomeFilter } from '~/utils/observability'
import { filterToolCallsByOutcome, formatMs } from '~/utils/observability'
import { agentKindMeta } from '~/utils/catalog'
import OutcomeFilterChips from '~/components/observability/OutcomeFilterChips.vue'

// The tool-call TRAJECTORY drill-down: what the run's agents DID, oldest first, in the order
// they did it. The sibling of the model-call list, and the one that holds the failures no LLM
// rollup counts — a tool that errors inside the container leaves the call that requested it
// reporting `ok`.
//
// Rows keep their trajectory order under every filter. Narrowing to the failures and reading
// them in sequence is what tells one tool that failed and was worked around from an edit loop
// stuck repeating the same failing call, and re-sorting by anything else destroys exactly that.
//
// TWO sources, because they answer at different bounds. `trajectory` is a bounded PREFIX of the
// run, so counting or narrowing it here would repeat, in JavaScript, the exact mistake the
// stores refuse to make in SQL: a run whose failures came after its opening moves would be shown
// as one whose tools all worked. So the failing rows and every count come from `failures`, which
// the backend narrowed and aggregated over the whole run, and only the browse view reads the
// prefix — under a banner that says it is one.
const props = defineProps<{
  trajectory: RunToolCallTrajectory
  /** The run-level failure read: exact counts, and the failing rows in trajectory order. */
  failures: RunToolCallFailures | null
  loading: boolean
  error: string | null
  failuresLoading: boolean
  failuresError: string | null
}>()
const emit = defineEmits<{
  /** Re-request the trajectory. */
  retry: []
  /** Re-request the failure read. */
  retryFailures: []
}>()

/** Which calls the list is narrowed to. Two-way bound so the failure summary can jump here. */
const filter = defineModel<ToolOutcomeFilter>('filter', { required: true })

const { t, d } = useI18n()

/**
 * Chip counts, taken from the run-level aggregate rather than the loaded rows.
 *
 * A chip is a claim about the run ("4 failed"), so counting the prefix would make it a claim
 * about the first two thousand calls wearing the run's name. Null until the aggregate answers:
 * the chips then read 0, which the loading state above them already accounts for.
 */
const counts = computed(() => {
  const total = props.failures?.total ?? 0
  const failed = props.failures?.failed ?? 0
  return { all: total, error: failed, ok: total - failed }
})
const filterOptions = computed(
  () =>
    [
      { value: 'all', label: t('observability.filter.all'), count: counts.value.all },
      {
        value: 'error',
        label: t('observability.filter.failed'),
        count: counts.value.error,
        tone: 'error',
      },
      { value: 'ok', label: t('observability.filter.ok'), count: counts.value.ok },
    ] as const,
)

/**
 * The rows on screen.
 *
 * `error` is served from the run-level failure read, so narrowing to the failures shows the
 * run's failures rather than the prefix's. `all` and `ok` browse the prefix, which is what the
 * banner below is for.
 */
const visible = computed(() =>
  filter.value === 'error'
    ? (props.failures?.failures ?? [])
    : filterToolCallsByOutcome(props.trajectory.toolCalls, filter.value),
)

/**
 * Whether what is on screen is bounded, and by which read.
 *
 * Stated per view rather than once for the component: narrowing to the failures escapes the
 * trajectory's prefix entirely, so carrying that bound's warning into the failure view would
 * cast doubt on a list that has none.
 */
/**
 * Which read backs the current view, with its own loading and error state.
 *
 * Per view, not per component. The failure view does not read the trajectory at all, so a
 * trajectory that is still loading (or failed to) must not blank out failing rows already in
 * hand — reporting an unrelated read's trouble as this view's emptiness is the same class of
 * mistake as reporting a prefix as a run.
 */
const source = computed(() =>
  filter.value === 'error'
    ? {
        loading: props.failuresLoading,
        error: props.failuresError,
        retry: () => emit('retryFailures'),
      }
    : { loading: props.loading, error: props.error, retry: () => emit('retry') },
)

const boundedNotice = computed(() => {
  if (filter.value === 'error') {
    return props.failures?.failuresTruncated
      ? t('observability.toolCalls.failuresTruncated', { shown: visible.value.length })
      : null
  }
  return props.trajectory.truncated
    ? t('observability.toolCalls.truncated', { shown: props.trajectory.toolCalls.length })
    : null
})

const expanded = reactive<Record<string, boolean>>({})
function toggle(call: AgentToolCall) {
  expanded[call.id] = !expanded[call.id]
}

function agentMeta(kind: string) {
  return agentKindMeta(kind)
}
function clock(ms: number): string {
  return d(new Date(ms), 'long')
}
/** Pretty-print JSON arguments; fall back to the raw string when they are not JSON. */
function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('observability.toolCalls.title') }}
        </h2>
        <p class="text-[11px] text-slate-600">{{ t('observability.toolCalls.subtitle') }}</p>
      </div>
      <OutcomeFilterChips v-model="filter" :options="filterOptions" />
    </div>

    <!-- Every state below is gated on having NOTHING to show: rows already in hand outrank a
         read still in flight behind them, and outrank one that failed. -->
    <p
      v-if="source.loading && !visible.length"
      class="flex items-center justify-center gap-2 py-8 text-center text-sm text-slate-500"
    >
      <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
      {{ t('observability.toolCalls.loading') }}
    </p>
    <div
      v-else-if="source.error && !visible.length"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed border-rose-900/60 py-6 text-center text-sm text-rose-400"
    >
      {{ t('observability.toolCalls.error') }}
      <UButton
        icon="i-lucide-rotate-cw"
        color="neutral"
        variant="soft"
        size="xs"
        :loading="source.loading"
        @click="source.retry()"
      >
        {{ t('common.retry') }}
      </UButton>
    </div>
    <!-- "The run made no tool calls" is a claim about the RUN, so it comes off the aggregate,
         never off an empty prefix that may simply not have loaded. -->
    <p
      v-else-if="!counts.all"
      class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
    >
      {{ t('observability.toolCalls.none') }}
    </p>
    <!-- Narrowed to nothing is a different statement from recorded nothing, and it is the more
         reassuring of the two: the operator asked for the failures and there are none. -->
    <p
      v-else-if="!visible.length"
      class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
    >
      {{ t('observability.toolCalls.noneMatching') }}
    </p>

    <template v-else>
      <!-- What this view is bounded by, when it is. A cap nobody can see is a prefix read as a
           whole run: the count beside every chip is the run's, so a shorter list than the count
           implies has to explain itself here. -->
      <p
        v-if="boundedNotice"
        class="rounded-lg border border-dashed border-amber-900/50 px-3 py-2 text-[11px] text-amber-300/90"
      >
        {{ boundedNotice }}
      </p>

      <ul class="space-y-2">
        <li
          v-for="call in visible"
          :key="call.id"
          class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40"
          :class="!call.ok ? 'border-rose-900/60' : ''"
        >
          <button
            class="flex w-full items-center gap-3 px-4 py-2.5 text-start transition hover:bg-slate-900/70"
            @click="toggle(call)"
          >
            <UIcon
              name="i-lucide-chevron-right"
              class="h-4 w-4 shrink-0 text-slate-500 transition-transform"
              :class="expanded[call.id] ? 'rotate-90' : ''"
            />
            <UIcon
              :name="agentMeta(call.agentKind).icon"
              class="h-4 w-4 shrink-0"
              :style="{ color: agentMeta(call.agentKind).color }"
              :title="agentMeta(call.agentKind).label"
            />
            <span class="font-mono text-[13px] text-slate-200">{{ call.tool }}</span>
            <div class="ms-auto flex items-center gap-2.5 text-[11px] tabular-nums text-slate-400">
              <span :title="t('observability.toolCalls.durationHint')">
                {{ formatMs(Math.max(0, call.endedAt - call.startedAt)) }}
              </span>
              <UBadge v-if="!call.ok" color="error" variant="subtle" size="sm">
                {{ t('observability.toolCalls.failed') }}
              </UBadge>
              <span class="hidden text-slate-600 md:inline">{{ clock(call.startedAt) }}</span>
            </div>
          </button>

          <div v-if="expanded[call.id]" class="border-t border-slate-800 px-4 py-3 space-y-3">
            <div class="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
              <span>{{ t('observability.toolCalls.dispatch', { jobId: call.jobId }) }}</span>
              <span>{{ t('observability.toolCalls.seq', { seq: call.seq }) }}</span>
            </div>
            <!-- `withheld` is not an empty body: nothing was captured, so an empty `args` here
               must not read as a tool that took none. -->
            <p v-if="call.bodies !== 'stored'" class="text-[12px] italic text-slate-500">
              {{ t('observability.toolCalls.bodiesWithheld') }}
            </p>
            <template v-else>
              <div>
                <div
                  class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500"
                >
                  <span>{{ t('observability.toolCalls.arguments') }}</span>
                  <span
                    v-if="call.argsDropped > 0"
                    class="normal-case tracking-normal text-slate-600"
                  >
                    {{ t('observability.toolCalls.dropped', { chars: call.argsDropped }) }}
                  </span>
                </div>
                <pre
                  class="max-h-60 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300"
                  >{{ call.args ? prettyArgs(call.args) : '—' }}</pre>
              </div>
              <div>
                <div
                  class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500"
                >
                  <span>{{ t('observability.toolCalls.result') }}</span>
                  <span
                    v-if="call.resultDropped > 0"
                    class="normal-case tracking-normal text-slate-600"
                  >
                    {{ t('observability.toolCalls.dropped', { chars: call.resultDropped }) }}
                  </span>
                </div>
                <pre
                  class="max-h-60 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed"
                  :class="call.ok ? 'text-slate-300' : 'text-rose-300'"
                  >{{ call.result || '—' }}</pre>
              </div>
            </template>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
