<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { LlmCallMetric } from '~/types/execution'
import { AGENT_BY_KIND } from '~/utils/catalog'
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

const executionId = computed(() => ui.observabilityInstanceId)
const open = computed(() => !!executionId.value)
const instance = computed(() => execution.getInstance(executionId.value ?? undefined))
const block = computed(() => (instance.value ? board.getBlock(instance.value.blockId) : undefined))

const calls = computed<LlmCallMetric[]>(() =>
  executionId.value ? observability.callsFor(executionId.value) : [],
)
const loading = computed(() => !!executionId.value && observability.isLoading(executionId.value))
const exporting = computed(() => !!executionId.value && observability.isExporting(executionId.value))
const error = computed(() =>
  executionId.value ? (observability.errors[executionId.value] ?? null) : null,
)

// Load (and refresh) whenever a different run's panel opens.
watch(executionId, (id) => {
  if (id) void observability.load(id)
})

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
function toggle(id: string) {
  expanded[id] = !expanded[id]
}

function agentMeta(kind: string) {
  return AGENT_BY_KIND[kind as keyof typeof AGENT_BY_KIND] ?? { label: kind, color: '#64748b', icon: 'i-lucide-bot' }
}
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString()
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
        class="fixed inset-0 z-50 flex flex-col bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15">
            <UIcon name="i-lucide-activity" class="h-5 w-5 text-sky-400" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">Model activity</h1>
            <p v-if="block" class="truncate text-xs text-slate-500">
              {{ block.title }} · {{ instance?.pipelineName }}
            </p>
          </div>
          <div class="ml-auto flex items-center gap-1.5">
            <UButton
              icon="i-lucide-download"
              color="neutral"
              variant="soft"
              size="sm"
              :loading="exporting"
              :disabled="!calls.length"
              title="Download an LLM-friendly JSON export of this run"
              @click="exportJson"
            >
              Export JSON
            </UButton>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              title="Close (Esc)"
              @click="close"
            />
          </div>
        </header>

        <div class="flex-1 overflow-auto px-6 py-6">
          <div class="mx-auto max-w-4xl space-y-5">
            <!-- run-level summary -->
            <section class="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-4">
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">Calls</dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">{{ totals.calls }}</dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">Tokens (in / out)</dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">
                    {{ formatTokens(totals.promptTokens) }} / {{ formatTokens(totals.completionTokens) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">Transport overhead</dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">
                    <span v-if="totals.transportPct !== null">
                      {{ totals.transportPct }}% · {{ formatMs(totals.overheadMs) }}
                    </span>
                    <span v-else class="text-slate-500">—</span>
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-slate-500">Model execution</dt>
                  <dd class="mt-0.5 tabular-nums text-slate-200">{{ formatMs(totals.upstreamMs) }}</dd>
                </div>
              </dl>
              <div class="mt-3 flex flex-wrap gap-1.5">
                <UBadge v-if="totals.errors" color="error" variant="subtle" size="sm">
                  {{ totals.errors }} error{{ totals.errors === 1 ? '' : 's' }}
                </UBadge>
                <UBadge v-if="totals.warnings" color="warning" variant="subtle" size="sm">
                  {{ totals.warnings }} warning{{ totals.warnings === 1 ? '' : 's' }}
                </UBadge>
                <UBadge v-if="totals.truncated" color="error" variant="subtle" size="sm">
                  {{ totals.truncated }} truncated
                </UBadge>
              </div>
            </section>

            <!-- states -->
            <p v-if="loading" class="flex items-center gap-2 py-8 text-center text-sm text-slate-500 justify-center">
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" /> Loading model activity…
            </p>
            <p v-else-if="error" class="rounded-lg border border-dashed border-rose-900/60 py-6 text-center text-sm text-rose-400">
              {{ error }}
            </p>
            <p
              v-else-if="!calls.length"
              class="rounded-lg border border-dashed border-slate-800 py-8 text-center text-sm text-slate-500"
            >
              No model calls recorded for this run.
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
                  class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-900/70"
                  @click="toggle(c.id)"
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
                  <span class="hidden truncate text-[11px] text-slate-500 sm:inline" :title="c.model">
                    {{ c.provider }}:{{ c.model }}
                  </span>
                  <div class="ml-auto flex items-center gap-2.5 text-[11px] tabular-nums text-slate-400">
                    <span :title="`${c.promptTokens} prompt / ${c.completionTokens} completion tokens`">
                      {{ formatTokens(c.promptTokens) }}↑ {{ formatTokens(c.completionTokens) }}↓
                    </span>
                    <span v-if="headroomOf(c) !== null" :title="'Output used vs limit'">
                      {{ headroomOf(c) }}%
                    </span>
                    <span title="Transport overhead / model execution">
                      {{ formatMs(c.overheadMs) }} / {{ formatMs(c.upstreamMs) }}
                    </span>
                    <UBadge
                      v-if="!c.ok"
                      color="error"
                      variant="subtle"
                      size="sm"
                    >
                      {{ c.httpStatus ?? 'error' }}
                    </UBadge>
                    <UBadge
                      v-else-if="isWarning(c.finishReason)"
                      color="warning"
                      variant="subtle"
                      size="sm"
                    >
                      {{ c.finishReason }}
                    </UBadge>
                    <span v-else class="text-slate-600">{{ c.finishReason ?? 'ok' }}</span>
                    <span class="hidden text-slate-600 md:inline">{{ clock(c.createdAt) }}</span>
                  </div>
                </button>

                <div v-if="expanded[c.id]" class="border-t border-slate-800 px-4 py-3 space-y-3">
                  <p v-if="c.errorMessage" class="text-[12px] text-rose-400">{{ c.errorMessage }}</p>
                  <div class="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
                    <span>{{ c.messageCount }} messages</span>
                    <span>{{ c.toolCount }} tools</span>
                    <span>{{ c.streaming ? 'streamed' : 'buffered' }}</span>
                    <span v-if="c.requestMaxTokens != null">max_tokens {{ c.requestMaxTokens }}</span>
                    <span v-if="c.cachedPromptTokens > 0" class="text-emerald-400"
                      >{{ c.cachedPromptTokens }}/{{ c.promptTokens }} prompt cached</span
                    >
                    <span>total {{ formatMs(c.totalMs) }}</span>
                  </div>
                  <div>
                    <div class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
                      <span>Prompt</span>
                      <span v-if="c.promptPrefixCount > 0" class="normal-case tracking-normal text-slate-600">
                        (new messages only — {{ c.promptPrefixCount }} earlier omitted)
                      </span>
                    </div>
                    <pre class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300">{{ prettyPrompt(c.promptText) }}</pre>
                  </div>
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Response</div>
                    <pre class="max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-300">{{ c.responseText || '—' }}</pre>
                  </div>
                </div>
              </li>
            </ul>
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
