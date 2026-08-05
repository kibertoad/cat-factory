<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { AgentToolCall } from '~/types/execution'
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
const props = defineProps<{
  toolCalls: AgentToolCall[]
  loading: boolean
  error: string | null
}>()
const emit = defineEmits<{ retry: [] }>()

/** Which calls the list is narrowed to. Two-way bound so the failure summary can jump here. */
const filter = defineModel<ToolOutcomeFilter>('filter', { required: true })

const { t, d } = useI18n()

const counts = computed(() => {
  const failed = props.toolCalls.filter((c) => !c.ok).length
  return { all: props.toolCalls.length, error: failed, ok: props.toolCalls.length - failed }
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

const visible = computed(() => filterToolCallsByOutcome(props.toolCalls, filter.value))

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

    <p
      v-if="loading && !toolCalls.length"
      class="flex items-center justify-center gap-2 py-8 text-center text-sm text-slate-500"
    >
      <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
      {{ t('observability.toolCalls.loading') }}
    </p>
    <div
      v-else-if="error && !toolCalls.length"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed border-rose-900/60 py-6 text-center text-sm text-rose-400"
    >
      {{ t('observability.toolCalls.error') }}
      <UButton
        icon="i-lucide-rotate-cw"
        color="neutral"
        variant="soft"
        size="xs"
        :loading="loading"
        @click="emit('retry')"
      >
        {{ t('common.retry') }}
      </UButton>
    </div>
    <p
      v-else-if="!toolCalls.length"
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

    <ul v-else class="space-y-2">
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
  </div>
</template>
