<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  LlmCallMetric,
  WebSearchProvider,
} from '~/types/execution'
import { agentKindMeta } from '~/utils/catalog'
import { formatMs, formatTokens, pct } from '~/utils/observability'

// Drill-down overlay for a run's LLM activity. Opened via
// `ui.openObservability(instanceId)` from a step surface; loads the full per-call
// detail (prompts, responses, token usage, output-limit headroom, the
// transport-vs-execution latency split) from the observability store and lists
// every model call, each expandable to its full prompt + response. Offers the
// LLM-friendly JSON export for handing a run to a model to analyse.
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

// Which view is shown: per-call model activity, the complete provided context, or the
// performed web searches.
const view = ref<'calls' | 'context' | 'search'>('calls')

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
      void observability.load(id)
      void observability.loadContext(id)
      void observability.loadSearchQueries(id)
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
  return {
    calls: c.length,
    promptTokens: sum(c, (x) => x.promptTokens),
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
function isWarning(finishReason: string | null): boolean {
  return finishReason === 'length' || finishReason === 'content_filter'
}

const expanded = reactive<Record<string, boolean>>({})
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
            <!-- run-level summary -->
            <section class="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-4">
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t('observability.summary.calls') }}
                  </dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">{{ totals.calls }}</dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t('observability.summary.tokensInOut') }}
                  </dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">
                    {{ formatTokens(totals.promptTokens) }} /
                    {{ formatTokens(totals.completionTokens) }}
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

            <!-- states -->
            <p
              v-if="loading && !calls.length"
              class="flex items-center gap-2 py-8 text-center text-sm text-slate-500 justify-center"
            >
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
              {{ t('observability.loadingActivity') }}
            </p>
            <p
              v-else-if="error"
              class="rounded-lg border border-dashed border-rose-900/60 py-6 text-center text-sm text-rose-400"
            >
              {{ error }}
            </p>
            <p
              v-else-if="!calls.length"
              class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
            >
              {{ t('observability.noCalls') }}
            </p>

            <!-- per-call list -->
            <ul v-else class="space-y-2">
              <li
                v-for="c in calls"
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
                  <span class="text-[13px] text-slate-200">{{ agentMeta(c.agentKind).label }}</span>
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
                          prompt: c.promptTokens,
                          completion: c.completionTokens,
                        })
                      "
                    >
                      {{ formatTokens(c.promptTokens) }}↑ {{ formatTokens(c.completionTokens) }}↓
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
                    <span v-if="c.cachedPromptTokens > 0" class="text-emerald-400">{{
                      t('observability.call.promptCached', {
                        cached: c.cachedPromptTokens,
                        prompt: c.promptTokens,
                      })
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
                      >{{ prettyPrompt(c.promptText) }}</pre
                    >
                  </div>
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.call.response') }}
                    </div>
                    <pre
                      class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300"
                      >{{ c.responseText || '—' }}</pre
                    >
                  </div>
                  <div v-if="c.reasoningText">
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.call.reasoning') }}
                    </div>
                    <pre
                      class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-400"
                      >{{ c.reasoningText }}</pre
                    >
                  </div>
                </div>
              </li>
            </ul>
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
                      >{{ s.systemPrompt || '—' }}</pre
                    >
                  </div>
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.context.userPrompt') }}
                    </div>
                    <pre
                      class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300"
                      >{{ s.userPrompt || '—' }}</pre
                    >
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
                        >{{ f.body }}</pre
                      >
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
                        >{{ file.content }}</pre
                      >
                    </div>
                  </div>
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {{ t('observability.context.details') }}
                    </div>
                    <pre
                      class="max-h-48 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-400"
                      >{{ prettyExtras(s.extras) }}</pre
                    >
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
