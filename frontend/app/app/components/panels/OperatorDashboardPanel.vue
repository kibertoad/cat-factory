<script setup lang="ts">
import { computed, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { AgentFailureKind, PlatformObservabilityWindow } from '~/types/execution'
import { formatMs } from '~/utils/observability'

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
]

// Exhaustive enum→label map (tier-2 dynamic-key guard): a new AgentFailureKind fails the
// typecheck here, and an out-of-enum kind falls back to its raw code below.
const FAILURE_KIND_KEYS: Record<AgentFailureKind, string> = {
  preflight: 'platformObservability.failureKind.preflight',
  dispatch: 'platformObservability.failureKind.dispatch',
  environment: 'platformObservability.failureKind.environment',
  evicted: 'platformObservability.failureKind.evicted',
  timeout: 'platformObservability.failureKind.timeout',
  agent: 'platformObservability.failureKind.agent',
  job_failed: 'platformObservability.failureKind.job_failed',
  rejected: 'platformObservability.failureKind.rejected',
  companion_rejected: 'platformObservability.failureKind.companion_rejected',
  stalled: 'platformObservability.failureKind.stalled',
  cancelled: 'platformObservability.failureKind.cancelled',
  unknown: 'platformObservability.failureKind.unknown',
}
function failureLabel(kind: string): string {
  const key = FAILURE_KIND_KEYS[kind as AgentFailureKind]
  return key ? t(key) : kind
}

// The largest failure count, so each taxonomy bar is drawn relative to the leader.
const maxFailure = computed(() => Math.max(1, ...(view.value?.failures ?? []).map((f) => f.count)))
// The largest total in any trend bucket, so each stacked column scales to the tallest.
const maxTrend = computed(() =>
  Math.max(1, ...(view.value?.trend.points ?? []).map((p) => p.done + p.failed + p.other)),
)

function barPct(count: number, max: number): number {
  return Math.round((count / max) * 100)
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
                    <dl v-else class="flex items-center justify-between gap-2 text-center">
                      <div class="flex-1">
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.avg') }}
                        </dt>
                        <dd class="font-semibold text-white">
                          {{ view.durations.avgMs == null ? '—' : formatMs(view.durations.avgMs) }}
                        </dd>
                      </div>
                      <div class="flex-1">
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.min') }}
                        </dt>
                        <dd class="font-semibold text-slate-300">
                          {{ view.durations.minMs == null ? '—' : formatMs(view.durations.minMs) }}
                        </dd>
                      </div>
                      <div class="flex-1">
                        <dt class="text-[11px] text-slate-500">
                          {{ t('platformObservability.durations.max') }}
                        </dt>
                        <dd class="font-semibold text-slate-300">
                          {{ view.durations.maxMs == null ? '—' : formatMs(view.durations.maxMs) }}
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
