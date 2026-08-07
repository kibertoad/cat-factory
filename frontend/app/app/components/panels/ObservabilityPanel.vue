<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import { isLlmWarningFinishReason } from '@cat-factory/contracts'
import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  LlmCallMetric,
  RunToolCallFailures,
  RunToolCallTrajectory,
  WebSearchProvider,
} from '~/types/execution'
import { agentKindMeta } from '~/utils/catalog'
import type { CallOutcomeFilter, ToolOutcomeFilter } from '~/utils/observability'
import {
  countCallOutcomes,
  deriveRunFailureEvidence,
  filterCallsByOutcome,
  foldRunPhaseMetrics,
  formatCost,
  formatMs,
  formatTokens,
  hasFailureEvidence,
  pct,
  sinkAnswer,
  sumCosts,
  totalInputTokens,
} from '~/utils/observability'
import OutcomeFilterChips from '~/components/observability/OutcomeFilterChips.vue'
import RunFailureSummary from '~/components/observability/RunFailureSummary.vue'
import ToolCallList from '~/components/observability/ToolCallList.vue'
import StepToolServers from '~/components/panels/StepToolServers.vue'

/** No run selected: the same empty, NOT-truncated trajectory the store answers with. */
const EMPTY_TRAJECTORY: RunToolCallTrajectory = Object.freeze({
  toolCalls: Object.freeze([]) as never,
  truncated: false,
})

// Drill-down overlay for a run's LLM activity. Opened via
// `ui.openObservability(instanceId)` from a step surface; loads the full per-call
// detail (prompts, responses, token usage, output-limit headroom, the
// transport-vs-execution latency split) from the observability store and lists
// every model call, each expandable to its full prompt + response. Offers the
// LLM-friendly JSON export for handing a run to a model to analyse.
//
// Failing-call FIRST: when the run failed (or any call did), the panel opens with a pinned
// summary naming the structured failure and the two calls that actually failed, so the cause is
// visible before anything is read. The lists below it narrow by outcome for the same reason:
// a tool-execution error is a row nothing aggregates, so finding one used to mean scrolling.
const ui = useUiStore()
const execution = useExecutionStore()
const board = useBoardStore()
const observability = useObservabilityStore()
const { t, d } = useI18n()

const executionId = computed(() => ui.observabilityInstanceId)
const open = computed(() => !!executionId.value)
const instance = computed(() => execution.getInstance(executionId.value ?? undefined))
const block = computed(() => (instance.value ? board.getBlock(instance.value.blockId) : undefined))

const calls = computed<LlmCallMetric[]>(() =>
  executionId.value ? observability.callsFor(executionId.value) : [],
)
const loading = computed(() => !!executionId.value && observability.isLoading(executionId.value))
const exporting = computed(
  () => !!executionId.value && observability.isExporting(executionId.value),
)
const error = computed(() =>
  executionId.value ? (observability.errors[executionId.value] ?? null) : null,
)
const contextError = computed(() =>
  executionId.value ? (observability.contextErrors[executionId.value] ?? null) : null,
)

function retryCalls() {
  if (executionId.value) void observability.load(executionId.value)
}
function retryContext() {
  if (executionId.value) void observability.loadContext(executionId.value)
}

// Which view is shown: per-call model activity, the tool-call trajectory, the complete provided
// context, or the performed web searches.
const view = ref<'calls' | 'tools' | 'context' | 'search'>('calls')

const contextSnapshots = computed<AgentContextSnapshot[]>(() =>
  executionId.value ? observability.contextFor(executionId.value) : [],
)
const contextLoading = computed(
  () => !!executionId.value && observability.isContextLoading(executionId.value),
)

const searchQueries = computed<AgentSearchQuery[]>(() =>
  executionId.value ? observability.searchQueriesFor(executionId.value) : [],
)
const searchLoading = computed(
  () => !!executionId.value && observability.isSearchQueriesLoading(executionId.value),
)

// The tool-call sink is read TWICE, at two different bounds, and the split is the point.
//
// `toolFailures` is the run-level answer: exact `{ total, failed }` counted in SQL plus the
// failing rows themselves, cheap enough to front the panel. `trajectory` is the browse view: a
// bounded prefix carrying every argument and result the run captured, loaded only when someone
// opens it. Folding them into one read would either make the headline wait on megabytes or make
// its numbers a statement about the prefix, and the second one is a false all-clear.
const trajectory = computed<RunToolCallTrajectory>(() =>
  executionId.value ? observability.toolCallsFor(executionId.value) : EMPTY_TRAJECTORY,
)
const toolCallsLoading = computed(
  () => !!executionId.value && observability.isToolCallsLoading(executionId.value),
)
const toolCallError = computed(() =>
  executionId.value ? (observability.toolCallErrors[executionId.value] ?? null) : null,
)
const toolFailures = computed<RunToolCallFailures | null>(() =>
  executionId.value ? observability.toolCallFailuresFor(executionId.value) : null,
)
const toolFailuresLoading = computed(
  () => !!executionId.value && observability.isToolCallFailuresLoading(executionId.value),
)
const toolFailureError = computed(() =>
  executionId.value ? (observability.toolCallFailureErrors[executionId.value] ?? null) : null,
)
function retryToolCalls() {
  if (executionId.value) void observability.loadToolCalls(executionId.value)
}
function retryToolCallFailures() {
  if (executionId.value) void observability.loadToolCallFailures(executionId.value)
}
/** Re-request whatever the pinned summary could not read. Both, when both failed. */
function retryFailureEvidence() {
  const id = executionId.value
  if (!id) return
  if (observability.toolCallFailureErrors[id]) void observability.loadToolCallFailures(id)
  if (observability.errors[id]) void observability.load(id)
}

/**
 * Show the trajectory tab, loading it if this is the first look.
 *
 * A named handler rather than two statements in the template: an inline handler is parsed as a
 * single expression, so the multi-statement form is a build-time syntax error that neither the
 * typecheck nor the unit tests compile a template to catch.
 */
function openToolsView() {
  view.value = 'tools'
  ensureTrajectoryLoaded()
}

/**
 * Load the trajectory the first time it is actually looked at.
 *
 * Deferred because it is the one read on this panel whose size scales with how much the run DID
 * rather than with how it ended, and an operator who opens the panel to see what broke may never
 * scroll it. What they do see immediately is the failure read, which is issued on open.
 */
function ensureTrajectoryLoaded() {
  const id = executionId.value
  if (!id || observability.hasToolCalls(id) || observability.isToolCallsLoading(id)) return
  void observability.loadToolCalls(id)
}

// --- failing-call-first triage ------------------------------------------------------------
// Both drill-downs narrow by outcome. The state lives HERE rather than in each list so the
// pinned summary's "show me the failing tool calls" can set it, and so switching views does not
// silently drop a narrowing the operator is still reading under.
const callFilter = ref<CallOutcomeFilter>('all')
const toolFilter = ref<ToolOutcomeFilter>('all')

const callOutcomeCounts = computed(() => countCallOutcomes(calls.value))
const callFilterOptions = computed(
  () =>
    [
      { value: 'all', label: t('observability.filter.all'), count: callOutcomeCounts.value.all },
      {
        value: 'error',
        label: t('observability.filter.failed'),
        count: callOutcomeCounts.value.error,
        tone: 'error',
      },
      {
        value: 'warning',
        label: t('observability.filter.warning'),
        count: callOutcomeCounts.value.warning,
        tone: 'warning',
      },
      { value: 'ok', label: t('observability.filter.ok'), count: callOutcomeCounts.value.ok },
    ] as const,
)
/** The rows the call list actually renders, after the outcome narrowing. */
const visibleCalls = computed(() => filterCallsByOutcome(calls.value, callFilter.value))

/**
 * What the panel pins at the top: the run's structured failure record plus the last call that
 * failed in each sink. Sharpens as each read lands rather than blocking on both.
 *
 * Each sink is passed its own ANSWER, not merely its rows, because zero rows is what a loading
 * read, a failed read, an unwired sink and a genuinely quiet run all look like from here, and
 * only the first two must never be rendered as "nothing failed".
 */
const failureEvidence = computed(() =>
  deriveRunFailureEvidence({
    failure: instance.value?.failure ?? null,
    calls: calls.value,
    callsAnswer: sinkAnswer({
      loading: loading.value,
      error: error.value,
      loaded: !!executionId.value && executionId.value in observability.callsByExecution,
      rows: calls.value.length,
    }),
    toolFailures: toolFailures.value,
    toolsAnswer: sinkAnswer({
      loading: toolFailuresLoading.value,
      error: toolFailureError.value,
      loaded: !!toolFailures.value,
      rows: toolFailures.value?.total ?? 0,
    }),
  }),
)
/**
 * Which call rows are expanded.
 *
 * Declared here rather than beside `toggle` below because `revealCall` writes it: the pinned
 * summary's jump opens the row it scrolls to, so the state has to exist above its first use.
 */
const expanded = reactive<Record<string, boolean>>({})

/**
 * Whether to pin the section at all.
 *
 * Deliberately NOT gated on `status === 'failed'`: a run still in flight whose calls are already
 * erroring is exactly the one worth interrupting, and a run that ended `done` after recovering
 * from a failure still has the failures worth reading. What the section never does is appear
 * with nothing to say: `hasFailureEvidence` is false when there is no record and nothing failed.
 */
const showFailureSummary = computed(() => hasFailureEvidence(failureEvidence.value))

/** Open one call's row in the list below, expanded, from the pinned summary. */
async function revealCall(callId: string) {
  view.value = 'calls'
  // Clear a narrowing that would hide the row we are about to scroll to. Every filter but
  // `error` can do that, and a jump to a row the list is not rendering silently does nothing.
  if (callFilter.value !== 'all' && callFilter.value !== 'error') callFilter.value = 'all'
  expanded[callId] = true
  await nextTick()
  document.getElementById(callRowId(callId))?.scrollIntoView({ block: 'center' })
}
/**
 * Open the trajectory narrowed to the failures, from the pinned summary.
 *
 * The failing rows are already in hand (they come from the failure read), so this renders
 * immediately; the prefix load it kicks off is what fills in the surrounding calls an operator
 * widens to when they want the context around one.
 */
function revealFailingToolCalls() {
  view.value = 'tools'
  toolFilter.value = 'error'
  ensureTrajectoryLoaded()
}
function callRowId(callId: string): string {
  return `obs-call-${callId}`
}

// Brand names, kept verbatim across locales (not translatable prose).
const PROVIDER_LABEL: Record<WebSearchProvider, string> = { brave: 'Brave', searxng: 'SearXNG' }
function providerLabel(provider: WebSearchProvider | null): string {
  return provider ? PROVIDER_LABEL[provider] : ''
}

// Whether web search was available to this run's container agents, and which provider(s)
// served it — a static per-run fact set on each container step at dispatch (not gated by
// prompt-recording telemetry, unlike the performed queries below).
const searchAvailability = computed<{ available: boolean; providers: WebSearchProvider[] } | null>(
  () => {
    const steps = (instance.value?.steps ?? []).filter((s) => s.search)
    if (!steps.length) return null
    const available = steps.some((s) => s.search?.available)
    const providers = [
      ...new Set(
        steps
          .map((s) => s.search)
          .filter((x): x is NonNullable<typeof x> => !!x?.available && !!x.provider)
          .map((x) => x.provider as WebSearchProvider),
      ),
    ]
    return { available, providers }
  },
)

// Load (and refresh) whenever a different run's panel opens. Reset to the calls view
// and load both the calls and the provided-context snapshots.
watch(
  executionId,
  (id) => {
    if (id) {
      view.value = 'calls'
      callFilter.value = 'all'
      toolFilter.value = 'all'
      void observability.load(id)
      void observability.loadContext(id)
      void observability.loadSearchQueries(id)
      // The FAILURE read on open, the trajectory on demand. This one is what the pinned summary
      // speaks from — the failure class no other number on the panel reveals — and it is two
      // aggregates and a handful of rows, so the headline answer costs a tab-click less than the
      // browse view it used to ride along with.
      void observability.loadToolCallFailures(id)
    }
  },
  // Lazy v-if mount: the panel mounts with executionId already set, so load immediately.
  { immediate: true },
)

const expandedCtx = reactive<Record<string, boolean>>({})
function toggleCtx(s: AgentContextSnapshot) {
  expandedCtx[s.id] = !expandedCtx[s.id]
}
function prettyExtras(extras: Record<string, unknown>): string {
  try {
    return JSON.stringify(extras, null, 2)
  } catch {
    return String(extras)
  }
}

// Run-level totals, derived from the loaded calls.
const totals = computed(() => {
  const c = calls.value
  const upstreamMs = sum(c, (x) => x.upstreamMs)
  const overheadMs = sum(c, (x) => x.overheadMs)
  const total = upstreamMs + overheadMs
  // The three input classes are orthogonal at the source, so they are simply summed —
  // `promptTokens` IS the fresh figure and needs no heuristic to recover it; the headline is
  // their TOTAL (see `totalInputTokens` — the like-for-like Claude Code context gauge).
  const promptTokens = sum(c, (x) => x.promptTokens)
  const cacheReadTokens = sum(c, (x) => x.cacheReadTokens)
  const cacheWriteTokens = sum(c, (x) => x.cacheWriteTokens)
  return {
    calls: c.length,
    promptTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens: totalInputTokens({ promptTokens, cacheReadTokens, cacheWriteTokens }),
    completionTokens: sum(c, (x) => x.completionTokens),
    upstreamMs,
    overheadMs,
    transportPct: total > 0 ? pct(overheadMs / total) : null,
    errors: c.filter((x) => !x.ok).length,
    warnings: c.filter((x) => x.ok && isWarning(x.finishReason)).length,
    truncated: c.filter((x) => x.finishReason === 'length').length,
  }
})

function sum(items: LlmCallMetric[], pick: (m: LlmCallMetric) => number): number {
  return items.reduce((acc, m) => acc + pick(m), 0)
}

// Where the run's tokens went, by PHASE. Unlike the totals above (derived from the capped call
// list), this reads the engine's SQL rollup off the steps, so it stays honest on a long run.
const phaseRows = computed(() => foldRunPhaseMetrics(instance.value?.steps ?? []))
const phaseCarryTotal = computed(() =>
  phaseRows.value.reduce((acc, p) => acc + p.carryCostTokens, 0),
)
/**
 * The currency the engine priced this run in. Read off the step rollups rather than assumed,
 * because the amounts come from a deployment-configured table whose currency an operator sets;
 * absent ⇒ nothing priced the run, and every amount below is null too.
 */
const costCurrency = computed(
  () => instance.value?.steps?.find((s) => s.metrics?.costCurrency)?.metrics?.costCurrency,
)
/**
 * Whether to show money at all: this deployment prices, and at least one phase of this run
 * actually got a figure.
 *
 * Deliberately NOT gated on the run TOTAL being known. A mixed-model run is the normal shape
 * (a harness CLI serves some turns with a model of its own choosing), so one phase on an
 * unpriced model is common — and gating the column on the total meant that one phase hid the
 * cost of every other, with no indication anything had been withheld.
 */
const showCost = computed(
  () => !!costCurrency.value && phaseRows.value.some((p) => p.costEstimate != null),
)
/**
 * The run's estimated cost, folded from the same SQL rollup the phase table shows — NOT from
 * the capped call list the token totals beside it use, which would silently under-report a run
 * longer than the page. Null when any phase could not be priced (see `sumCosts`), in which case
 * the tile SAYS the total is incomplete rather than quietly dropping it: a missing figure and a
 * partial one are both wrong to render as a number, but only one of them is worth explaining.
 */
const runCost = computed(() =>
  formatCost(sumCosts(phaseRows.value.map((p) => p.costEstimate)), costCurrency.value),
)
/** Share of the run's carry cost a phase accounts for (0..100), or null when nothing carried. */
function carryShare(carryCostTokens: number): number | null {
  return phaseCarryTotal.value > 0 ? pct(carryCostTokens / phaseCarryTotal.value) : null
}
/**
 * The phase label as shown. The vocabulary belongs to the HARNESS — it is whatever its handlers
 * pass to `onPhase`, so there is deliberately no closed union to translate against; a newer
 * image's phase must render verbatim rather than disappear. The one label the platform owns is
 * the empty string, which means "nothing could attribute this call" and needs saying in words.
 */
function phaseLabel(phase: string): string {
  return phase || t('observability.phase.unattributed')
}
/**
 * Whether a successful call's finish reason is a warning (cut short, or filtered).
 *
 * The rule itself lives in `@cat-factory/contracts` beside the backend's own classification: a
 * hand-copied list here was fine while it only picked a badge colour, and stopped being fine the
 * moment the outcome FILTER decides which rows the operator is shown.
 */
function isWarning(finishReason: string | null): boolean {
  return isLlmWarningFinishReason(finishReason)
}

function toggle(c: LlmCallMetric) {
  expanded[c.id] = !expanded[c.id]
  // A live-streamed row arrives without its prompt/response bodies (the event stays
  // small). On first expand, backfill them from the persisted metrics endpoint —
  // `load` replaces the list with the full rows (same ids), so the open row fills in.
  if (expanded[c.id] && !c.promptText && !c.responseText && executionId.value && !loading.value) {
    void observability.load(executionId.value)
  }
}

function agentMeta(kind: string) {
  return agentKindMeta(kind)
}
function clock(ms: number): string {
  return d(new Date(ms), 'long')
}
/** Pretty-print the prompt JSON; fall back to the raw string if it isn't JSON. */
function prettyPrompt(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
function headroomOf(m: LlmCallMetric): number | null {
  if (m.requestMaxTokens == null || m.requestMaxTokens <= 0) return null
  return pct(Math.min(1, m.completionTokens / m.requestMaxTokens))
}

function close() {
  ui.closeObservability()
}
onKeyStroke('Escape', () => {
  if (open.value) close()
})
function exportJson() {
  if (executionId.value) void observability.downloadExport(executionId.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="obs-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex flex-col bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15">
            <UIcon name="i-lucide-activity" class="h-5 w-5 text-sky-400" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">
              {{ t('observability.modelActivity') }}
            </h1>
            <p v-if="block" class="truncate text-xs text-slate-500">
              {{ block.title }} · {{ instance?.pipelineName }}
            </p>
          </div>
          <div class="ms-auto flex items-center gap-1.5">
            <div class="me-1 flex rounded-lg border border-slate-800 p-0.5 text-[12px]">
              <button
                class="rounded-md px-2.5 py-1 transition"
                :class="
                  view === 'calls'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                "
                @click="view = 'calls'"
              >
                {{ t('observability.modelActivity') }}
              </button>
              <button
                class="rounded-md px-2.5 py-1 transition"
                :class="
                  view === 'tools'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                "
                @click="openToolsView()"
              >
                {{ t('observability.toolCalls.title') }}
              </button>
              <button
                class="rounded-md px-2.5 py-1 transition"
                :class="
                  view === 'context'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                "
                @click="view = 'context'"
              >
                {{ t('observability.providedContext') }}
              </button>
              <button
                class="rounded-md px-2.5 py-1 transition"
                :class="
                  view === 'search'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                "
                @click="view = 'search'"
              >
                {{ t('observability.webSearch') }}
              </button>
            </div>
            <UButton
              v-if="view === 'calls'"
              icon="i-lucide-download"
              color="neutral"
              variant="soft"
              size="sm"
              :loading="exporting"
              :disabled="!calls.length"
              :title="t('observability.exportHint')"
              @click="exportJson"
            >
              {{ t('observability.exportJson') }}
            </UButton>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              :title="t('observability.closeEsc')"
              @click="close"
            />
          </div>
        </header>

        <div class="flex-1 overflow-auto px-6 py-6">
          <div v-if="view === 'calls'" class="mx-auto max-w-4xl space-y-5">
            <!-- What broke, pinned ABOVE everything: the structured failure record plus the last
                 call that failed in each sink. The point of the panel's first screen is that the
                 cause is read, not hunted. -->
            <RunFailureSummary
              v-if="showFailureSummary"
              :evidence="failureEvidence"
              @show-call="revealCall"
              @show-failing-tools="revealFailingToolCalls"
              @retry="retryFailureEvidence"
            />

            <!-- run-level summary -->
            <section class="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-4">
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t('observability.summary.calls') }}
                  </dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">{{ totals.calls }}</dd>
                </div>
                <div v-if="showCost">
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t('observability.summary.cost') }}
                  </dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">
                    {{ runCost ?? '—' }}
                    <span class="mt-0.5 block text-[11px] text-slate-500">
                      {{
                        runCost
                          ? t('observability.summary.costHint')
                          : t('observability.summary.costIncomplete')
                      }}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t('observability.summary.tokensInOut') }}
                  </dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">
                    <span :title="t('observability.summary.inputTokensHint')">
                      {{ formatTokens(totals.inputTokens) }} /
                      {{ formatTokens(totals.completionTokens) }}
                    </span>
                    <span
                      v-if="totals.cacheReadTokens > 0 || totals.cacheWriteTokens > 0"
                      class="mt-0.5 block text-[11px]"
                    >
                      <span class="text-slate-400" :title="t('observability.summary.freshHint')">
                        {{
                          t('observability.summary.fresh', {
                            tokens: formatTokens(totals.promptTokens),
                          })
                        }}
                      </span>
                      <template v-if="totals.cacheReadTokens > 0">
                        <span class="text-slate-600"> · </span>
                        <span
                          class="text-emerald-400/80"
                          :title="t('observability.summary.cacheReadHint')"
                        >
                          {{
                            t('observability.summary.cacheRead', {
                              tokens: formatTokens(totals.cacheReadTokens),
                            })
                          }}
                        </span>
                      </template>
                      <template v-if="totals.cacheWriteTokens > 0">
                        <span class="text-slate-600"> · </span>
                        <span
                          class="text-amber-400/80"
                          :title="t('observability.summary.cacheWriteHint')"
                        >
                          {{
                            t('observability.summary.cacheWrite', {
                              tokens: formatTokens(totals.cacheWriteTokens),
                            })
                          }}
                        </span>
                      </template>
                    </span>
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t('observability.summary.transportOverhead') }}
                  </dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">
                    <span v-if="totals.transportPct !== null">
                      {{ totals.transportPct }}% · {{ formatMs(totals.overheadMs) }}
                    </span>
                    <span v-else class="text-slate-500">—</span>
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t('observability.summary.modelExecution') }}
                  </dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">
                    {{ formatMs(totals.upstreamMs) }}
                  </dd>
                </div>
              </dl>
              <div class="mt-3 flex flex-wrap gap-1.5">
                <UBadge v-if="totals.errors" color="error" variant="subtle" size="sm">
                  {{
                    t('observability.metricsBar.errors', { count: totals.errors }, totals.errors)
                  }}
                </UBadge>
                <UBadge v-if="totals.warnings" color="warning" variant="subtle" size="sm">
                  {{
                    t(
                      'observability.metricsBar.warnings',
                      { count: totals.warnings },
                      totals.warnings,
                    )
                  }}
                </UBadge>
                <UBadge v-if="totals.truncated" color="error" variant="subtle" size="sm">
                  {{
                    t(
                      'observability.summary.truncated',
                      { count: totals.truncated },
                      totals.truncated,
                    )
                  }}
                </UBadge>
              </div>
            </section>

            <!-- where the run's tokens went, by phase (the engine's SQL rollup, not the
                 capped call list) -->
            <section
              v-if="phaseRows.length"
              class="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
            >
              <div class="flex items-baseline gap-2">
                <h2 class="text-[11px] uppercase tracking-wide text-slate-500">
                  {{ t('observability.phase.title') }}
                </h2>
                <span class="text-[11px] text-slate-600">
                  {{ t('observability.phase.subtitle') }}
                </span>
              </div>
              <div class="mt-3 overflow-x-auto">
                <table class="w-full min-w-[32rem] text-[12px]">
                  <thead>
                    <tr class="text-[11px] uppercase tracking-wide text-slate-500">
                      <th class="py-1 pe-3 text-start font-normal">
                        {{ t('observability.phase.columns.phase') }}
                      </th>
                      <th class="py-1 px-3 text-end font-normal">
                        {{ t('observability.phase.columns.turns') }}
                      </th>
                      <th class="py-1 px-3 text-end font-normal">
                        {{ t('observability.phase.columns.tokensInOut') }}
                      </th>
                      <th v-if="showCost" class="py-1 px-3 text-end font-normal">
                        <span :title="t('observability.phase.costHint')">
                          {{ t('observability.phase.columns.cost') }}
                        </span>
                      </th>
                      <!-- The sort key, MARKED as one. Rows lead with carry cost rather than
                           with tokens, and the two orders genuinely differ: a phase that runs
                           late carries almost nothing however much it spent (nothing after it
                           re-sends its context). Leaving that implicit invites reading row 1
                           as "the phase that burned the most", which is the neighbouring
                           column. -->
                      <th aria-sort="descending" class="py-1 ps-3 text-end font-normal">
                        <span :title="t('observability.phase.carryCostHint')">
                          {{ t('observability.phase.columns.carryCost') }} ↓
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="p in phaseRows" :key="p.phase" class="border-t border-slate-800/70">
                      <td class="py-1.5 pe-3 text-slate-200">
                        <span :class="p.phase ? '' : 'text-slate-400 italic'">
                          {{ phaseLabel(p.phase) }}
                        </span>
                        <span v-if="!p.phase" class="ms-1.5 text-[11px] text-slate-600">
                          {{ t('observability.phase.unattributedHint') }}
                        </span>
                        <UBadge
                          v-if="p.errors"
                          color="error"
                          variant="subtle"
                          size="sm"
                          class="ms-2"
                        >
                          {{ t('observability.metricsBar.errors', { count: p.errors }, p.errors) }}
                        </UBadge>
                      </td>
                      <td class="py-1.5 px-3 text-end tabular-nums text-slate-300">
                        {{ p.calls }}
                      </td>
                      <td class="py-1.5 px-3 text-end tabular-nums text-slate-300">
                        {{ formatTokens(totalInputTokens(p)) }}↑
                        {{ formatTokens(p.completionTokens) }}↓
                      </td>
                      <td v-if="showCost" class="py-1.5 px-3 text-end tabular-nums text-slate-300">
                        <!-- An em dash, not 0: this phase's model had no rate, and a zero here
                             would read as a phase that cost nothing. -->
                        {{ formatCost(p.costEstimate, costCurrency) ?? '—' }}
                      </td>
                      <td class="py-1.5 ps-3 text-end tabular-nums text-slate-300">
                        {{ formatTokens(p.carryCostTokens) }}
                        <span v-if="carryShare(p.carryCostTokens) !== null" class="text-slate-600">
                          · {{ carryShare(p.carryCostTokens) }}%
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <!-- states -->
            <p
              v-if="loading && !calls.length"
              class="flex items-center gap-2 py-8 text-center text-sm text-slate-500 justify-center"
            >
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
              {{ t('observability.loadingActivity') }}
            </p>
            <div
              v-else-if="error"
              class="flex flex-col items-center gap-3 rounded-lg border border-dashed border-rose-900/60 py-6 text-center text-sm text-rose-400"
            >
              {{ error }}
              <UButton
                icon="i-lucide-rotate-cw"
                color="neutral"
                variant="soft"
                size="xs"
                :loading="loading"
                @click="retryCalls"
              >
                {{ t('common.retry') }}
              </UButton>
            </div>
            <p
              v-else-if="!calls.length"
              class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
            >
              {{ t('observability.noCalls') }}
            </p>

            <!-- per-call list, narrowable by outcome -->
            <template v-else>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2 class="text-[11px] uppercase tracking-wide text-slate-500">
                  {{ t('observability.callsTitle') }}
                </h2>
                <OutcomeFilterChips v-model="callFilter" :options="callFilterOptions" />
              </div>

              <!-- Narrowed to nothing reads differently from recorded nothing, and on this
                   surface it is the good news: the operator asked for the failures and there
                   are none. -->
              <p
                v-if="!visibleCalls.length"
                class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
              >
                {{ t('observability.noCallsMatching') }}
              </p>

              <ul v-else class="space-y-2">
                <li
                  v-for="c in visibleCalls"
                  :id="callRowId(c.id)"
                  :key="c.id"
                  class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40"
                  :class="!c.ok ? 'border-rose-900/60' : ''"
                >
                  <button
                    class="flex w-full items-center gap-3 px-4 py-2.5 text-start transition hover:bg-slate-900/70"
                    @click="toggle(c)"
                  >
                    <UIcon
                      name="i-lucide-chevron-right"
                      class="h-4 w-4 shrink-0 text-slate-500 transition-transform"
                      :class="expanded[c.id] ? 'rotate-90' : ''"
                    />
                    <UIcon
                      :name="agentMeta(c.agentKind).icon"
                      class="h-4 w-4 shrink-0"
                      :style="{ color: agentMeta(c.agentKind).color }"
                    />
                    <span class="text-[13px] text-slate-200">{{
                      agentMeta(c.agentKind).label
                    }}</span>
                    <span
                      class="hidden truncate text-[11px] text-slate-500 sm:inline"
                      :title="c.model"
                    >
                      {{ c.provider }}:{{ c.model }}
                    </span>
                    <div
                      class="ms-auto flex items-center gap-2.5 text-[11px] tabular-nums text-slate-400"
                    >
                      <span
                        :title="
                          t('observability.call.tokensTitle', {
                            input: totalInputTokens(c),
                            fresh: c.promptTokens,
                            completion: c.completionTokens,
                          })
                        "
                      >
                        {{ formatTokens(totalInputTokens(c)) }}↑
                        {{ formatTokens(c.completionTokens) }}↓
                      </span>
                      <span
                        v-if="headroomOf(c) !== null"
                        :title="t('observability.call.outputUsedVsLimit')"
                      >
                        {{ headroomOf(c) }}%
                      </span>
                      <span :title="t('observability.call.transportVsExecution')">
                        {{ formatMs(c.overheadMs) }} / {{ formatMs(c.upstreamMs) }}
                      </span>
                      <UBadge v-if="!c.ok" color="error" variant="subtle" size="sm">
                        {{ c.httpStatus ?? t('observability.call.error') }}
                      </UBadge>
                      <UBadge
                        v-else-if="isWarning(c.finishReason)"
                        color="warning"
                        variant="subtle"
                        size="sm"
                      >
                        {{ c.finishReason }}
                      </UBadge>
                      <span v-else class="text-slate-600">{{
                        c.finishReason ?? t('observability.call.ok')
                      }}</span>
                      <span class="hidden text-slate-600 md:inline">{{ clock(c.createdAt) }}</span>
                    </div>
                  </button>

                  <div v-if="expanded[c.id]" class="border-t border-slate-800 px-4 py-3 space-y-3">
                    <p v-if="c.errorMessage" class="text-[12px] text-rose-400">
                      {{ c.errorMessage }}
                    </p>
                    <div class="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
                      <span>{{ t('observability.call.messages', { count: c.messageCount }) }}</span>
                      <span>{{ t('observability.call.tools', { count: c.toolCount }) }}</span>
                      <span>{{
                        c.streaming
                          ? t('observability.call.streamed')
                          : t('observability.call.buffered')
                      }}</span>
                      <span v-if="c.requestMaxTokens != null">{{
                        t('observability.call.maxTokens', { value: c.requestMaxTokens })
                      }}</span>
                      <span v-if="c.cacheReadTokens > 0 || c.cacheWriteTokens > 0">{{
                        t('observability.call.fresh', { tokens: c.promptTokens })
                      }}</span>
                      <span v-if="c.cacheReadTokens > 0" class="text-emerald-400">{{
                        t('observability.call.cacheRead', { tokens: c.cacheReadTokens })
                      }}</span>
                      <span v-if="c.cacheWriteTokens > 0" class="text-amber-400">{{
                        t('observability.call.cacheWrite', { tokens: c.cacheWriteTokens })
                      }}</span>
                      <span>{{
                        t('observability.call.total', { duration: formatMs(c.totalMs) })
                      }}</span>
                    </div>
                    <div>
                      <div
                        class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500"
                      >
                        <span>{{ t('observability.call.prompt') }}</span>
                        <span
                          v-if="c.promptPrefixCount > 0"
                          class="normal-case tracking-normal text-slate-600"
                        >
                          {{
                            t('observability.call.promptPrefixOmitted', {
                              count: c.promptPrefixCount,
                            })
                          }}
                        </span>
                      </div>
                      <pre
                        class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300"
                        >{{ prettyPrompt(c.promptText) }}</pre>
                    </div>
                    <div>
                      <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                        {{ t('observability.call.response') }}
                      </div>
                      <pre
                        class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300"
                        >{{ c.responseText || '—' }}</pre>
                    </div>
                    <div v-if="c.reasoningText">
                      <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                        {{ t('observability.call.reasoning') }}
                      </div>
                      <pre
                        class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-400"
                        >{{ c.reasoningText }}</pre>
                    </div>
                  </div>
                </li>
              </ul>
            </template>
          </div>

          <!-- Tool-call trajectory: what the run's agents DID, in the order they did it. -->
          <div v-else-if="view === 'tools'" class="mx-auto max-w-4xl space-y-5">
            <RunFailureSummary
              v-if="showFailureSummary"
              :evidence="failureEvidence"
              @show-call="revealCall"
              @show-failing-tools="revealFailingToolCalls"
              @retry="retryFailureEvidence"
            />
            <ToolCallList
              v-model:filter="toolFilter"
              :trajectory="trajectory"
              :failures="toolFailures"
              :loading="toolCallsLoading"
              :error="toolCallError"
              :failures-loading="toolFailuresLoading"
              :failures-error="toolFailureError"
              @retry="retryToolCalls"
              @retry-failures="retryToolCallFailures"
            />
          </div>

          <!-- Provided context: the complete context each container agent was given. -->
          <div v-else-if="view === 'context'" class="mx-auto max-w-4xl space-y-5">
            <p
              v-if="contextLoading && !contextSnapshots.length"
              class="flex items-center justify-center gap-2 py-8 text-center text-sm text-slate-500"
            >
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
              {{ t('observability.loadingContext') }}
            </p>
            <div
              v-else-if="contextError && !contextSnapshots.length"
              class="flex flex-col items-center gap-3 rounded-lg border border-dashed border-rose-900/60 py-8 text-center text-sm text-rose-400"
            >
              {{ t('observability.contextError') }}
              <UButton
                icon="i-lucide-rotate-cw"
                color="neutral"
                variant="soft"
                size="xs"
                :loading="contextLoading"
                @click="retryContext"
              >
                {{ t('common.retry') }}
              </UButton>
            </div>
            <p
              v-else-if="!contextSnapshots.length"
              class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
            >
              {{ t('observability.noContext') }}
            </p>

            <ul v-else class="space-y-2">
              <li
                v-for="s in contextSnapshots"
                :key="s.id"
                class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40"
              >
                <button
                  class="flex w-full items-center gap-3 px-4 py-2.5 text-start transition hover:bg-slate-900/70"
                  @click="toggleCtx(s)"
                >
                  <UIcon
                    name="i-lucide-chevron-right"
                    class="h-4 w-4 shrink-0 text-slate-500 transition-transform"
                    :class="expandedCtx[s.id] ? 'rotate-90' : ''"
                  />
                  <UIcon
                    :name="agentMeta(s.agentKind).icon"
                    class="h-4 w-4 shrink-0"
                    :style="{ color: agentMeta(s.agentKind).color }"
                  />
                  <span class="text-[13px] text-slate-200">{{ agentMeta(s.agentKind).label }}</span>
                  <span v-if="s.model" class="hidden truncate text-[11px] text-slate-500 sm:inline">
                    {{ s.model }}
                  </span>
                  <div
                    class="ms-auto flex items-center gap-2.5 text-[11px] tabular-nums text-slate-400"
                  >
                    <span :title="t('observability.context.injectedFiles')">{{
                      t('observability.context.filesCount', { count: s.contextFiles.length })
                    }}</span>
                    <span :title="t('observability.context.bestPracticeFragments')">{{
                      t('observability.context.fragmentsCount', { count: s.fragments.length })
                    }}</span>
                    <span class="hidden text-slate-600 md:inline">{{ clock(s.createdAt) }}</span>
                  </div>
                </button>

                <div v-if="expandedCtx[s.id]" class="border-t border-slate-800 px-4 py-3 space-y-3">
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.context.systemPrompt') }}
                    </div>
                    <pre
                      class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300"
                      >{{ s.systemPrompt || '—' }}</pre>
                  </div>
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.context.userPrompt') }}
                    </div>
                    <pre
                      class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300"
                      >{{ s.userPrompt || '—' }}</pre>
                  </div>
                  <div v-if="s.fragments.length">
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.context.bestPracticeFragments') }}
                    </div>
                    <div
                      v-for="f in s.fragments"
                      :key="f.id"
                      class="mb-2 rounded-lg bg-slate-950/70 p-3"
                    >
                      <div class="mb-1 text-[11px] text-slate-400">{{ f.id }}</div>
                      <pre
                        class="max-h-48 overflow-auto text-[11px] leading-relaxed text-slate-300"
                        >{{ f.body }}</pre>
                    </div>
                  </div>
                  <div v-if="s.contextFiles.length">
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.context.injectedFiles') }}
                    </div>
                    <div
                      v-for="file in s.contextFiles"
                      :key="file.path"
                      class="mb-2 rounded-lg bg-slate-950/70 p-3"
                    >
                      <div class="mb-1 text-[11px] text-slate-400">
                        {{ file.title }}
                        <span class="text-slate-600">· {{ file.path }}</span>
                      </div>
                      <pre
                        class="max-h-72 overflow-auto text-[11px] leading-relaxed text-slate-300"
                        >{{ file.content }}</pre>
                    </div>
                  </div>
                  <!-- The tool servers (MCP) this dispatch wired and dropped. A typed field on the
                       snapshot rather than a line in the JSON dump below, because "the Slack
                       server was dropped for a missing credential" is a fact someone opens this
                       panel to find, not one to discover while scrolling a blob. -->
                  <StepToolServers v-if="s.toolServers?.length" :servers="s.toolServers" />
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.context.details') }}
                    </div>
                    <pre
                      class="max-h-48 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-400"
                      >{{ prettyExtras(s.extras) }}</pre>
                  </div>
                </div>
              </li>
            </ul>
          </div>

          <div v-else class="mx-auto max-w-4xl space-y-5">
            <!-- Availability header: a static per-run fact (not telemetry-gated). -->
            <section
              v-if="searchAvailability"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-[13px]"
            >
              <span class="text-[11px] uppercase tracking-wide text-slate-500">
                {{ t('observability.webSearch') }}
              </span>
              <span
                class="inline-flex items-center gap-1.5"
                :class="searchAvailability.available ? 'text-emerald-300' : 'text-slate-400'"
              >
                <UIcon
                  :name="searchAvailability.available ? 'i-lucide-globe' : 'i-lucide-globe-lock'"
                  class="h-4 w-4"
                />
                {{
                  searchAvailability.available
                    ? t('observability.search.available')
                    : t('observability.search.unavailable')
                }}
              </span>
              <span v-if="searchAvailability.providers.length" class="text-slate-400 tabular-nums">
                {{ t('observability.search.provider') }}:
                {{ searchAvailability.providers.map(providerLabel).join(', ') }}
              </span>
            </section>

            <p
              v-if="searchLoading && !searchQueries.length"
              class="flex items-center justify-center gap-2 py-8 text-center text-sm text-slate-500"
            >
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
              {{ t('observability.loadingSearch') }}
            </p>
            <p
              v-else-if="!searchQueries.length"
              class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
            >
              {{ t('observability.noSearch') }}
            </p>

            <div v-else>
              <div class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
                {{ t('observability.search.queriesTitle') }}
              </div>
              <ul class="space-y-2">
                <li
                  v-for="q in searchQueries"
                  :key="q.id"
                  class="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-2.5"
                >
                  <UIcon
                    :name="agentMeta(q.agentKind).icon"
                    class="h-4 w-4 shrink-0"
                    :style="{ color: agentMeta(q.agentKind).color }"
                    :title="agentMeta(q.agentKind).label"
                  />
                  <span class="min-w-0 flex-1 truncate text-[13px] text-slate-200" :title="q.query">
                    {{ q.query }}
                  </span>
                  <div
                    class="flex shrink-0 items-center gap-2.5 text-[11px] tabular-nums text-slate-400"
                  >
                    <span v-if="q.provider" class="hidden sm:inline">{{
                      providerLabel(q.provider)
                    }}</span>
                    <span>{{
                      t(
                        'observability.search.resultsCount',
                        { count: q.resultCount },
                        q.resultCount,
                      )
                    }}</span>
                    <span class="hidden text-slate-600 md:inline">{{ clock(q.createdAt) }}</span>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.obs-fade-enter-active,
.obs-fade-leave-active {
  transition: opacity 0.18s ease;
}
.obs-fade-enter-from,
.obs-fade-leave-to {
  opacity: 0;
}
</style>
