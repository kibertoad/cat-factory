<script setup lang="ts">
import { computed, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { PlatformObservabilityWindow } from '~/types/execution'
import { formatMs } from '~/utils/observability'
import { FAILURE_KIND_KEYS, isAgentFailureKind } from '~/utils/failureKinds'

// Deployment-level (platform-operator) observability dashboard: the aggregate health of the
// active account's runs — outcome totals + success rate, a time-bucketed outcome trend, the
// failure-kind taxonomy, live/parked depth, and duration stats — over a selectable window.
// Admin-gated; opened via `ui.openOperatorDashboard()` from the sidebar. The account-scoped
// counterpart of the per-run `ObservabilityPanel`.
const ui = useUiStore()
const accounts = useAccountsStore()
const platform = usePlatformObservabilityStore()
const { t, d, n } = useI18n()

const open = computed(() => ui.operatorDashboardOpen)
const view = computed(() => platform.view)
const loading = computed(() => platform.loading)
const error = computed(() => platform.error)
const accountName = computed(() => accounts.activeAccount?.name ?? '')

// Window options as static literal keys (keeps the typed-message-key check live).
const WINDOWS: { value: PlatformObservabilityWindow; label: string }[] = [
  { value: '1h', label: t('platformObservability.window.oneHour') },
  { value: '24h', label: t('platformObservability.window.oneDay') },
  { value: '7d', label: t('platformObservability.window.sevenDays') },
  { value: '30d', label: t('platformObservability.window.thirtyDays') },
  { value: '90d', label: t('platformObservability.window.ninetyDays') },
]

// The enum→label map is SHARED with the alert-settings panel (`~/utils/failureKinds`), which
// offers the same vocabulary as the subject of a per-kind alert rule: one map, so the kind an
// operator points a page at and the kind this breakdown shows can never be labelled differently.
// An out-of-enum kind (a retired one on an old row) falls back to its raw code.
function failureLabel(kind: string): string {
  return isAgentFailureKind(kind) ? t(FAILURE_KIND_KEYS[kind]) : kind
}

const DAY_MS = 24 * 60 * 60 * 1000

// How the window was answered. A rollup-backed window that has materialised NOTHING must not
// render as a quiet quarter, and one whose watermark is well behind `now` must not render its
// empty tail as idleness, so the banner distinguishes "no rollup yet", "the rollup is behind"
// and "up to date" rather than leaving all three to look like data.
const rollupState = computed<'none' | 'stale' | 'current' | null>(() => {
  const v = view.value
  if (!v || v.source !== 'daily-rollup') return null
  if (v.rolledUpThrough == null) return 'none'
  // A day of slack: the sweep materialises the CURRENT day, so being one bucket behind is the
  // normal state between passes rather than a gap worth flagging.
  return v.generatedAt - v.rolledUpThrough > 2 * DAY_MS ? 'stale' : 'current'
})

// The largest failure count, so each taxonomy bar is drawn relative to the leader.
const maxFailure = computed(() => Math.max(1, ...(view.value?.failures ?? []).map((f) => f.count)))
// The largest total in any trend bucket, so each stacked column scales to the tallest.
const maxTrend = computed(() =>
  Math.max(1, ...(view.value?.trend.points ?? []).map((p) => p.done + p.failed + p.other)),
)

function barPct(count: number, max: number): number {
  return Math.round((count / max) * 100)
}

// Share of a gate kind's runs the precheck satisfied outright, 0..1: the number the
// precheck-before-escalate design exists to move. Null (not 0) when nothing settled, because
// "no gates ran" is not "every gate needed a fixer".
function cleanRate(stat: { gates: number; cleanPasses: number }): number | null {
  return stat.gates > 0 ? stat.cleanPasses / stat.gates : null
}
function heightPct(count: number, max: number): number {
  // Floor a non-zero column to 4% so a single run is still visible in the sparkline.
  return count === 0 ? 0 : Math.max(4, Math.round((count / max) * 100))
}
function trendTooltip(p: { start: number; done: number; failed: number; other: number }): string {
  return `${d(new Date(p.start), 'short')} · ${t('platformObservability.trend.done')} ${p.done} · ${t('platformObservability.trend.failed')} ${p.failed} · ${t('platformObservability.trend.other')} ${p.other}`
}

function setWindow(w: PlatformObservabilityWindow) {
  void platform.setWindow(w)
}
function refresh() {
  void platform.load()
}
function close() {
  ui.closeOperatorDashboard()
}
onKeyStroke('Escape', () => {
  if (open.value) close()
})

// Load (and refresh) whenever the dashboard opens.
watch(
  open,
  (isOpen) => {
    if (isOpen) void platform.load()
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="obs-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex flex-col bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        data-testid="operator-dashboard"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15">
            <UIcon name="i-lucide-gauge" class="h-5 w-5 text-sky-400" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">
              {{ t('platformObservability.title') }}
            </h1>
            <p v-if="accountName" class="truncate text-xs text-slate-500">{{ accountName }}</p>
          </div>
          <div class="ms-auto flex items-center gap-1.5">
            <div class="me-1 flex rounded-lg border border-slate-800 p-0.5 text-[12px]">
              <button
                v-for="opt in WINDOWS"
                :key="opt.value"
                class="rounded-md px-2.5 py-1 transition"
                :class="
                  platform.window === opt.value
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                "
                :data-testid="`operator-window-${opt.value}`"
                @click="setWindow(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
            <button
              class="rounded-lg border border-slate-800 p-1.5 text-slate-400 transition hover:text-slate-200"
              :title="t('platformObservability.refresh')"
              :aria-label="t('platformObservability.refresh')"
              data-testid="operator-refresh"
              @click="refresh"
            >
              <UIcon
                name="i-lucide-refresh-cw"
                class="h-4 w-4"
                :class="{ 'animate-spin': loading }"
              />
            </button>
            <button
              class="rounded-lg border border-slate-800 p-1.5 text-slate-400 transition hover:text-slate-200"
              :title="t('platformObservability.close')"
              :aria-label="t('platformObservability.close')"
              data-testid="operator-close"
              @click="close"
            >
              <UIcon name="i-lucide-x" class="h-4 w-4" />
            </button>
          </div>
        </header>

        <div class="flex-1 overflow-y-auto px-6 py-5">
          <div
            v-if="error"
            class="mx-auto max-w-2xl rounded-lg border border-rose-800/60 bg-rose-950/40 p-4 text-sm text-rose-200"
          >
            <p>{{ error }}</p>
            <button
              class="mt-2 rounded-md border border-rose-700 px-3 py-1 text-xs hover:bg-rose-900/40"
              @click="refresh"
            >
              {{ t('platformObservability.retry') }}
            </button>
          </div>

          <div v-else-if="loading && !view" class="py-16 text-center text-sm text-slate-400">
            {{ t('platformObservability.loading') }}
          </div>

          <div v-else-if="view" class="mx-auto flex max-w-5xl flex-col gap-6">
            <!--
              Rollup provenance. An un-materialised rollup and an idle quarter produce the same
              empty series, so the long windows say which one this is instead of showing
              confident zeros.
            -->
            <p
              v-if="rollupState === 'none'"
              class="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
              data-testid="operator-rollup-missing"
            >
              {{ t('platformObservability.rollup.none') }}
            </p>
            <p
              v-else-if="rollupState === 'stale'"
              class="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
              data-testid="operator-rollup-stale"
            >
              {{
                t('platformObservability.rollup.stale', {
                  date: d(new Date(view.rolledUpThrough ?? 0), 'short'),
                })
              }}
            </p>
            <p
              v-else-if="rollupState === 'current'"
              class="text-xs text-slate-500"
              data-testid="operator-rollup-current"
            >
              {{
                t('platformObservability.rollup.current', {
                  date: d(new Date(view.rolledUpThrough ?? 0), 'short'),
                })
              }}
            </p>

            <!-- Outcome summary tiles -->
            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {{ t('platformObservability.outcomes.title') }}
              </h2>
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p class="text-2xl font-semibold text-white">
                    {{ n(view.outcomes.total, 'decimal') }}
                  </p>
                  <p class="text-xs text-slate-500">
                    {{ t('platformObservability.outcomes.total') }}
                  </p>
                </div>
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p class="text-2xl font-semibold text-emerald-400">
                    {{ n(view.outcomes.done, 'decimal') }}
                  </p>
                  <p class="text-xs text-slate-500">
                    {{ t('platformObservability.outcomes.done') }}
                  </p>
                </div>
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p class="text-2xl font-semibold text-rose-400">
                    {{ n(view.outcomes.failed, 'decimal') }}
                  </p>
                  <p class="text-xs text-slate-500">
                    {{ t('platformObservability.outcomes.failed') }}
                  </p>
                </div>
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p
                    class="text-2xl font-semibold text-sky-400"
                    data-testid="operator-success-rate"
                  >
                    {{
                      view.outcomes.successRate == null
                        ? '—'
                        : n(view.outcomes.successRate, 'percent')
                    }}
                  </p>
                  <p class="text-xs text-slate-500">
                    {{ t('platformObservability.outcomes.successRate') }}
                  </p>
                </div>
              </div>
            </section>

            <!-- Outcome trend sparkline -->
            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {{ t('platformObservability.trend.title') }}
              </h2>
              <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <div
                  v-if="view.outcomes.total === 0"
                  class="py-6 text-center text-xs text-slate-500"
                >
                  {{ t('platformObservability.trend.empty') }}
                </div>
                <div v-else class="flex h-28 items-end gap-0.5" data-testid="operator-trend">
                  <div
                    v-for="p in view.trend.points"
                    :key="p.start"
                    class="flex flex-1 flex-col justify-end"
                    :title="trendTooltip(p)"
                  >
                    <div
                      class="w-full rounded-t-sm bg-rose-500/80"
                      :style="{ height: `${heightPct(p.failed, maxTrend)}%` }"
                    />
                    <div
                      class="w-full bg-slate-500/60"
                      :style="{ height: `${heightPct(p.other, maxTrend)}%` }"
                    />
                    <div
                      class="w-full rounded-b-sm bg-emerald-500/80"
                      :style="{ height: `${heightPct(p.done, maxTrend)}%` }"
                    />
                  </div>
                </div>
                <div class="mt-2 flex items-center gap-4 text-[11px] text-slate-500">
                  <span class="flex items-center gap-1"
                    ><span class="h-2 w-2 rounded-sm bg-emerald-500/80" />{{
                      t('platformObservability.trend.done')
                    }}</span
                  >
                  <span class="flex items-center gap-1"
                    ><span class="h-2 w-2 rounded-sm bg-rose-500/80" />{{
                      t('platformObservability.trend.failed')
                    }}</span
                  >
                  <span class="flex items-center gap-1"
                    ><span class="h-2 w-2 rounded-sm bg-slate-500/60" />{{
                      t('platformObservability.trend.other')
                    }}</span
                  >
                </div>
              </div>
            </section>

            <!-- Gate / CI-fixer attempt statistics -->
            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {{ t('platformObservability.gates.title') }}
              </h2>
              <div class="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <p v-if="!view.gates.length" class="py-4 text-center text-xs text-slate-500">
                  {{ t('platformObservability.gates.empty') }}
                </p>
                <table v-else class="w-full text-left text-xs" data-testid="operator-gates">
                  <thead class="text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th class="pb-2 pe-3 font-medium">
                        {{ t('platformObservability.gates.gate') }}
                      </th>
                      <th class="pb-2 pe-3 text-end font-medium">
                        {{ t('platformObservability.gates.settled') }}
                      </th>
                      <th class="pb-2 pe-3 text-end font-medium">
                        {{ t('platformObservability.gates.cleanPasses') }}
                      </th>
                      <th class="pb-2 pe-3 text-end font-medium">
                        {{ t('platformObservability.gates.attempts') }}
                      </th>
                      <th class="pb-2 pe-3 text-end font-medium">
                        {{ t('platformObservability.gates.helperFailures') }}
                      </th>
                      <th class="pb-2 text-end font-medium">
                        {{ t('platformObservability.gates.exhausted') }}
                      </th>
                    </tr>
                  </thead>
                  <tbody class="text-slate-300">
                    <tr
                      v-for="g in view.gates"
                      :key="g.gateKind"
                      class="border-t border-slate-800/70"
                    >
                      <td class="py-2 pe-3">
                        <span class="font-medium text-slate-200">{{ g.gateKind }}</span>
                        <span v-if="g.helperKind" class="ms-1.5 text-slate-500"
                          >&rarr; {{ g.helperKind }}</span
                        >
                      </td>
                      <td class="py-2 pe-3 text-end tabular-nums">{{ g.gates }}</td>
                      <td class="py-2 pe-3 text-end tabular-nums">
                        <span class="text-emerald-400">{{ g.cleanPasses }}</span>
                        <span v-if="cleanRate(g) !== null" class="ms-1 text-slate-500"
                          >({{ n(cleanRate(g) ?? 0, 'percent') }})</span
                        >
                      </td>
                      <td class="py-2 pe-3 text-end tabular-nums">{{ g.attempts }}</td>
                      <td class="py-2 pe-3 text-end tabular-nums">
                        <span :class="g.helperFailures > 0 ? 'text-amber-400' : ''">{{
                          g.helperFailures
                        }}</span>
                      </td>
                      <td class="py-2 text-end tabular-nums">
                        <span :class="g.exhausted > 0 ? 'text-rose-400' : ''">{{
                          g.exhausted
                        }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p class="mt-3 text-[11px] leading-relaxed text-slate-500">
                  {{ t('platformObservability.gates.hint') }}
                </p>
              </div>
            </section>

            <div class="grid gap-6 md:grid-cols-2">
              <!-- Failure taxonomy -->
              <section>
                <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('platformObservability.failures.title') }}
                </h2>
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                  <div v-if="!view.failures.length" class="py-4 text-center text-xs text-slate-500">
                    {{ t('platformObservability.failures.empty') }}
                  </div>
                  <ul v-else class="flex flex-col gap-2" data-testid="operator-failures">
                    <li v-for="f in view.failures" :key="f.kind" class="text-xs">
                      <div class="mb-0.5 flex items-center justify-between">
                        <span class="text-slate-300">{{ failureLabel(f.kind) }}</span>
                        <span class="tabular-nums text-slate-400">{{ f.count }}</span>
                      </div>
                      <div class="h-1.5 rounded-full bg-slate-800">
                        <div
                          class="h-1.5 rounded-full bg-rose-500/70"
                          :style="{ width: `${barPct(f.count, maxFailure)}%` }"
                        />
                      </div>
                    </li>
                  </ul>
                </div>
              </section>

              <!-- Live depth + durations -->
              <section class="flex flex-col gap-4">
                <div>
                  <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {{ t('platformObservability.live.title') }}
                  </h2>
                  <div
                    class="grid grid-cols-4 gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-center"
                    data-testid="operator-live"
                  >
                    <div>
                      <p class="text-lg font-semibold text-sky-400">{{ view.live.running }}</p>
                      <p class="text-[11px] text-slate-500">
                        {{ t('platformObservability.outcomes.running') }}
                      </p>
                    </div>
                    <div>
                      <p class="text-lg font-semibold text-amber-400">{{ view.live.blocked }}</p>
                      <p class="text-[11px] text-slate-500">
                        {{ t('platformObservability.outcomes.blocked') }}
                      </p>
                    </div>
                    <div>
                      <p class="text-lg font-semibold text-slate-300">{{ view.live.paused }}</p>
                      <p class="text-[11px] text-slate-500">
                        {{ t('platformObservability.outcomes.paused') }}
                      </p>
                    </div>
                    <div>
                      <p class="text-lg font-semibold text-slate-300">{{ view.live.pending }}</p>
                      <p class="text-[11px] text-slate-500">
                        {{ t('platformObservability.outcomes.pending') }}
                      </p>
                    </div>
                  </div>
                </div>
                <div>
                  <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {{ t('platformObservability.durations.title') }}
                  </h2>
                  <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm">
                    <div
                      v-if="view.durations.count === 0"
                      class="py-2 text-center text-xs text-slate-500"
                    >
                      {{ t('platformObservability.durations.empty') }}
                    </div>
                    <dl
                      v-else
                      class="grid grid-cols-3 gap-y-3 text-center"
                      data-testid="operator-durations"
                    >
                      <div>
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.avg') }}
                        </dt>
                        <dd class="font-semibold text-white">
                          {{ view.durations.avgMs == null ? '—' : formatMs(view.durations.avgMs) }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.min') }}
                        </dt>
                        <dd class="font-semibold text-slate-300">
                          {{ view.durations.minMs == null ? '—' : formatMs(view.durations.minMs) }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.max') }}
                        </dt>
                        <dd class="font-semibold text-slate-300">
                          {{ view.durations.maxMs == null ? '—' : formatMs(view.durations.maxMs) }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.p50') }}
                        </dt>
                        <dd
                          class="font-semibold text-slate-300"
                          data-testid="operator-duration-p50"
                        >
                          {{ view.durations.p50Ms == null ? '—' : formatMs(view.durations.p50Ms) }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.p90') }}
                        </dt>
                        <dd
                          class="font-semibold text-slate-300"
                          data-testid="operator-duration-p90"
                        >
                          {{ view.durations.p90Ms == null ? '—' : formatMs(view.durations.p90Ms) }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.p99') }}
                        </dt>
                        <dd
                          class="font-semibold text-slate-300"
                          data-testid="operator-duration-p99"
                        >
                          {{ view.durations.p99Ms == null ? '—' : formatMs(view.durations.p99Ms) }}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </section>
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
  transition: opacity 0.15s ease;
}
.obs-fade-enter-from,
.obs-fade-leave-to {
  opacity: 0;
}
</style>
