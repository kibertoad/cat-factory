<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import { lastCompleteRollupDay } from '@cat-factory/contracts'
import type {
  ReportActivityDimension,
  ReportActivityRow,
  ReportSpendRow,
  ReportWindow,
} from '~/types/execution'
import { formatMs, formatTokens } from '~/utils/observability'
import {
  activitySegments,
  columnPct,
  isUnattributed,
  maxOf,
  segmentPct,
  trendMagnitude,
} from './ReportsPanel.logic'
import ReportsSpendBreakdown from '~/components/panels/ReportsSpendBreakdown.vue'

// Reports: cross-cutting usage analytics for the active account — where the spend and the
// work actually go. Spend per model and agent kind, spend + run activity per workspace /
// service / task type, and a spend trend, over a selectable window and optionally narrowed
// to one board. Admin-gated; opened via `ui.openReports()` from the sidebar. The sibling of
// `OperatorDashboardPanel`, which answers the health question over the same account scope.
//
// Charting follows the panel-native idiom (Tailwind marks, no charting dependency), with
// two deliberate encodings:
//   - SPEND is two series — `violet-500` metered (real money) and `amber-600` subscription
//     (the illustrative equivalent-API cost of flat-rate quota usage). The pair is validated
//     colorblind-safe against the dark surface, and a legend is always present.
//   - ACTIVITY uses the app's RESERVED status colors (emerald done / rose failed / sky
//     running / slate other), which are red-green adjacent by design across the product.
//     Every status is therefore ALSO carried as a number under its bar and named in the
//     legend, so identity is never colour alone.
const ui = useUiStore()
const accounts = useAccountsStore()
const workspace = useWorkspaceStore()
const reports = useReportsStore()
const { t, te, d, n } = useI18n()

const open = computed(() => ui.reportsOpen)
const view = computed(() => reports.view)
const loading = computed(() => reports.loading)
const failed = computed(() => reports.failed)
/** The backend's untranslated message, shown as detail under the localized heading. */
const error = computed(() => reports.error)
const accountName = computed(() => accounts.activeAccount?.name ?? '')

// Window options as static literal keys (keeps the typed-message-key check live).
const WINDOWS: { value: ReportWindow; label: string }[] = [
  { value: '24h', label: t('reports.window.oneDay') },
  { value: '7d', label: t('reports.window.sevenDays') },
  { value: '30d', label: t('reports.window.thirtyDays') },
  { value: '90d', label: t('reports.window.ninetyDays') },
]

// The dimension the paired spend + activity breakdowns are grouped by. Model and agent
// kind have no activity counterpart (a run carries no single kind), so they render
// unconditionally above rather than joining this switch.
const DIMENSIONS: { value: ReportActivityDimension; label: string }[] = [
  { value: 'workspace', label: t('reports.dimension.workspace') },
  { value: 'service', label: t('reports.dimension.service') },
  { value: 'taskType', label: t('reports.dimension.taskType') },
]
const dimension = ref<ReportActivityDimension>('workspace')

const currency = computed(() => view.value?.currency ?? 'EUR')
const money = (value: number) => n(value, { key: 'currency', currency: currency.value })

/** A slice's display name: the resolved label, the raw key, or the unattributed notice. */
function sliceLabel(row: { key: string; label: string | null }): string {
  if (isUnattributed(row.key)) return t('reports.unattributed')
  return row.label ?? row.key
}

const spendByDimension = computed<ReportSpendRow[]>(() => {
  const spend = view.value?.spend
  if (!spend) return []
  if (dimension.value === 'workspace') return spend.byWorkspace
  if (dimension.value === 'service') return spend.byService
  return spend.byTaskType
})
const activityByDimension = computed<ReportActivityRow[]>(() => {
  const activity = view.value?.activity
  if (!activity) return []
  if (dimension.value === 'workspace') return activity.byWorkspace
  if (dimension.value === 'service') return activity.byService
  return activity.byTaskType
})

const DAY_MS = 24 * 60 * 60 * 1000

// How the window's SPEND half was answered. The long (TCO) windows read the durable
// cost-attribution rollup, which is only as fresh as the last retention sweep, so a rollup
// that has materialised NOTHING must not render as a quiet quarter and one whose watermark is
// well behind `now` must not render its empty tail as thrift. Same three states as the
// operator dashboard's daily run rollup.
//
// The lag is measured against `lastCompleteRollupDay(generatedAt)`, NOT against `generatedAt`
// itself, because that is what `rolledUpThrough` counts in: the newest day the sweep could
// possibly have finished by now. Measuring against the wall clock instead compares a day
// boundary with an instant, so the very same healthy rollup drifts from ~0h of apparent lag
// just after midnight to ~24h just before the next one, and any fixed threshold then turns the
// hour the report happened to be opened into a health verdict. One whole missed day of slack
// is deliberate: the sweep is a daily cron on one facade, so a single skipped firing is a
// hiccup the next pass heals, while two in a row is the wedge worth naming.
const rollupState = computed<'none' | 'stale' | 'current' | null>(() => {
  const v = view.value
  if (!v || v.source !== 'daily-rollup') return null
  if (v.rolledUpThrough == null) return 'none'
  return lastCompleteRollupDay(v.generatedAt) - v.rolledUpThrough > DAY_MS ? 'stale' : 'current'
})

const maxTrend = computed(() => maxOf(view.value?.trend.points ?? [], trendMagnitude))
const hasSpend = computed(() => (view.value?.totals.calls ?? 0) > 0)
// Hoisted: every activity bar is scaled against the busiest slice in the SAME list, so this
// is invariant across the row loop. Computing it inline would re-scan the list once per
// status segment of every row.
const maxRuns = computed(() => maxOf(activityByDimension.value, (row) => row.runs))

/** Boards the filter offers — the active account's, since the report is account-scoped. */
const boards = computed(() => workspace.accountWorkspaces)

function trendTooltip(point: { start: number; meteredCost: number; subscriptionCost: number }) {
  return `${d(new Date(point.start), 'short')} · ${t('reports.legend.metered')} ${money(point.meteredCost)} · ${t('reports.legend.subscription')} ${money(point.subscriptionCost)}`
}

// Exhaustive enum→key map (the tier-2 dynamic-key guard): a new activity status fails the
// typecheck here rather than silently rendering a raw code.
const STATUS_KEYS: Record<'done' | 'failed' | 'running' | 'other', string> = {
  done: 'reports.status.done',
  failed: 'reports.status.failed',
  running: 'reports.status.running',
  other: 'reports.status.other',
}
const STATUS_CLASSES: Record<'done' | 'failed' | 'running' | 'other', string> = {
  done: 'bg-emerald-500',
  failed: 'bg-rose-500',
  running: 'bg-sky-500',
  other: 'bg-slate-500',
}
/** `te`-guarded so a locale missing the key shows the raw status, never a raw message key. */
function statusLabel(status: 'done' | 'failed' | 'running' | 'other'): string {
  const key = STATUS_KEYS[status]
  return te(key) ? t(key) : status
}

function refresh() {
  void reports.load()
}
function close() {
  ui.closeReports()
}
onKeyStroke('Escape', () => {
  if (open.value) close()
})

// Load (and refresh) whenever the panel opens.
watch(
  open,
  (isOpen) => {
    if (isOpen) void reports.load()
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="reports-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex flex-col bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        data-testid="reports-panel"
      >
        <header class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15"
          >
            <UIcon name="i-lucide-chart-column" class="h-5 w-5 text-violet-400" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">{{ t('reports.title') }}</h1>
            <p v-if="accountName" class="truncate text-xs text-slate-500">{{ accountName }}</p>
          </div>
          <!-- Filters in ONE row above the charts: window, then board scope. -->
          <div class="ms-auto flex flex-wrap items-center gap-1.5">
            <select
              class="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-[12px] text-slate-200"
              :value="reports.workspaceFilter ?? ''"
              :aria-label="t('reports.filter.board')"
              data-testid="reports-board-filter"
              @change="
                reports.setWorkspaceFilter(($event.target as HTMLSelectElement).value || null)
              "
            >
              <option value="">{{ t('reports.filter.allBoards') }}</option>
              <option v-for="board in boards" :key="board.id" :value="board.id">
                {{ board.name }}
              </option>
            </select>
            <div class="me-1 flex rounded-lg border border-slate-800 p-0.5 text-[12px]">
              <button
                v-for="opt in WINDOWS"
                :key="opt.value"
                class="rounded-md px-2.5 py-1 transition"
                :class="
                  reports.window === opt.value
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                "
                :data-testid="`reports-window-${opt.value}`"
                @click="reports.setWindow(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
            <button
              class="rounded-lg border border-slate-800 p-1.5 text-slate-400 transition hover:text-slate-200"
              :aria-label="t('reports.refresh')"
              :title="t('reports.refresh')"
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
              :aria-label="t('common.close')"
              @click="close"
            >
              <UIcon name="i-lucide-x" class="h-4 w-4" />
            </button>
          </div>
        </header>

        <div class="flex-1 overflow-y-auto px-6 py-5">
          <div
            v-if="failed"
            class="mx-auto max-w-2xl rounded-lg border border-rose-800/60 bg-rose-950/40 p-4 text-sm text-rose-200"
          >
            <p>{{ t('reports.error') }}</p>
            <p v-if="error" class="mt-1 text-xs text-rose-300/80">{{ error }}</p>
            <button
              class="mt-2 rounded-md border border-rose-700 px-3 py-1 text-xs hover:bg-rose-900/40"
              @click="refresh"
            >
              {{ t('reports.retry') }}
            </button>
          </div>

          <div v-else-if="loading && !view" class="py-16 text-center text-sm text-slate-400">
            {{ t('reports.loading') }}
          </div>

          <div v-else-if="view" class="mx-auto flex max-w-5xl flex-col gap-6">
            <p class="text-[11px] text-slate-500">
              {{
                t('reports.period', {
                  from: d(new Date(view.since), 'short'),
                  to: d(new Date(view.generatedAt), 'short'),
                })
              }}
            </p>

            <!-- Which store answered, and how far it reaches. An un-materialised rollup and an
                 account that spent nothing produce the same empty breakdown. -->
            <p
              v-if="rollupState === 'none'"
              class="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
              data-testid="reports-rollup-none"
            >
              {{ t('reports.rollup.none') }}
            </p>
            <p
              v-else-if="rollupState === 'stale'"
              class="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
              data-testid="reports-rollup-stale"
            >
              {{
                t('reports.rollup.stale', {
                  date: d(new Date(view.rolledUpThrough ?? 0), 'short'),
                })
              }}
            </p>
            <p
              v-else-if="rollupState === 'current'"
              class="text-[11px] text-slate-500"
              data-testid="reports-rollup-current"
            >
              {{
                t('reports.rollup.current', {
                  date: d(new Date(view.rolledUpThrough ?? 0), 'short'),
                })
              }}
            </p>

            <!-- Headline totals. A stat tile, not a chart: these are single numbers. -->
            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {{ t('reports.totals.title') }}
              </h2>
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p class="text-2xl font-semibold text-violet-300" data-testid="reports-metered">
                    {{ money(view.totals.meteredCost) }}
                  </p>
                  <p class="text-xs text-slate-500">{{ t('reports.totals.metered') }}</p>
                </div>
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p class="text-2xl font-semibold text-amber-300">
                    {{ money(view.totals.subscriptionCost) }}
                  </p>
                  <p class="text-xs text-slate-500">{{ t('reports.totals.subscription') }}</p>
                </div>
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p class="text-2xl font-semibold text-white">
                    {{ n(view.totals.calls, 'decimal') }}
                  </p>
                  <p class="text-xs text-slate-500">{{ t('reports.totals.calls') }}</p>
                </div>
                <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <p class="text-2xl font-semibold text-white">
                    {{ formatTokens(view.totals.inputTokens + view.totals.outputTokens) }}
                  </p>
                  <p class="text-xs text-slate-500">{{ t('reports.totals.tokens') }}</p>
                </div>
              </div>
              <p class="mt-1.5 text-[10px] text-slate-500">
                {{ t('reports.totals.illustrative') }}
              </p>
            </section>

            <!-- Spend over time. One axis, two stacked series, legend always present. -->
            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {{ t('reports.trend.title') }}
              </h2>
              <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <div v-if="!hasSpend" class="py-6 text-center text-xs text-slate-500">
                  {{ t('reports.trend.empty') }}
                </div>
                <div v-else class="flex h-28 items-end gap-0.5" data-testid="reports-trend">
                  <div
                    v-for="point in view.trend.points"
                    :key="point.start"
                    class="flex flex-1 flex-col justify-end gap-[2px]"
                    :title="trendTooltip(point)"
                  >
                    <div
                      class="w-full rounded-t-sm bg-amber-600"
                      :style="{ height: `${columnPct(point.subscriptionCost, maxTrend)}%` }"
                    />
                    <div
                      class="w-full rounded-sm bg-violet-500"
                      :style="{ height: `${columnPct(point.meteredCost, maxTrend)}%` }"
                    />
                  </div>
                </div>
                <div class="mt-2 flex items-center gap-4 text-[11px] text-slate-500">
                  <span class="flex items-center gap-1" :title="t('reports.legend.meteredHint')">
                    <span class="h-2 w-2 rounded-sm bg-violet-500" />{{
                      t('reports.legend.metered')
                    }}
                  </span>
                  <span
                    class="flex items-center gap-1"
                    :title="t('reports.legend.subscriptionHint')"
                  >
                    <span class="h-2 w-2 rounded-sm bg-amber-600" />{{
                      t('reports.legend.subscription')
                    }}
                  </span>
                </div>
              </div>
            </section>

            <!-- Spend by model + by agent kind: the two axes a run has no single value for. -->
            <div class="grid gap-6 md:grid-cols-2">
              <section>
                <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('reports.spend.byModel') }}
                </h2>
                <ReportsSpendBreakdown
                  :rows="view.spend.byModel"
                  :currency="currency"
                  test-id="reports-spend-model"
                  :label-of="sliceLabel"
                />
              </section>
              <section>
                <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('reports.spend.byAgentKind') }}
                </h2>
                <ReportsSpendBreakdown
                  :rows="view.spend.byAgentKind"
                  :currency="currency"
                  test-id="reports-spend-agent-kind"
                  :label-of="sliceLabel"
                />
              </section>
            </div>

            <!-- The TCO axes: what a repository, a ticket and a single run actually cost.
                 Spend-only, like the pair above, because a run's activity is already sliced by
                 the service that owns the repo and there is no second population to pair a
                 ticket with, and a run IS the unit activity counts. -->
            <div class="grid gap-6 md:grid-cols-3">
              <section>
                <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('reports.spend.byRepo') }}
                </h2>
                <ReportsSpendBreakdown
                  :rows="view.spend.byRepo"
                  :currency="currency"
                  test-id="reports-spend-repo"
                  :label-of="sliceLabel"
                />
              </section>
              <section>
                <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('reports.spend.byTicket') }}
                </h2>
                <ReportsSpendBreakdown
                  :rows="view.spend.byTicket"
                  :currency="currency"
                  test-id="reports-spend-ticket"
                  :label-of="sliceLabel"
                />
              </section>
              <section>
                <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('reports.spend.byRun') }}
                </h2>
                <ReportsSpendBreakdown
                  :rows="view.spend.byRun"
                  :currency="currency"
                  test-id="reports-spend-run"
                  :label-of="sliceLabel"
                />
              </section>
            </div>

            <!-- The shared axis: spend AND activity for the same grouping, side by side. -->
            <section class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('reports.breakdown.title') }}
                </h2>
                <div class="flex rounded-lg border border-slate-800 p-0.5 text-[12px]">
                  <button
                    v-for="opt in DIMENSIONS"
                    :key="opt.value"
                    class="rounded-md px-2.5 py-1 transition"
                    :class="
                      dimension === opt.value
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    "
                    :data-testid="`reports-dimension-${opt.value}`"
                    @click="dimension = opt.value"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </div>
              <div class="grid gap-6 md:grid-cols-2">
                <div>
                  <h3 class="mb-2 text-[11px] text-slate-500">{{ t('reports.spend.heading') }}</h3>
                  <ReportsSpendBreakdown
                    :rows="spendByDimension"
                    :currency="currency"
                    test-id="reports-spend-dimension"
                    :label-of="sliceLabel"
                  />
                </div>
                <div>
                  <h3 class="mb-2 text-[11px] text-slate-500">
                    {{ t('reports.activity.heading') }}
                  </h3>
                  <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                    <div
                      v-if="!activityByDimension.length"
                      class="py-4 text-center text-xs text-slate-500"
                    >
                      {{ t('reports.activity.empty') }}
                    </div>
                    <template v-else>
                      <ul class="flex flex-col gap-3" data-testid="reports-activity">
                        <li
                          v-for="row in activityByDimension"
                          :key="row.key"
                          class="text-xs"
                          data-testid="reports-activity-row"
                        >
                          <div class="mb-1 flex items-baseline justify-between gap-2">
                            <span class="min-w-0 truncate text-slate-300">{{
                              sliceLabel(row)
                            }}</span>
                            <span class="shrink-0 tabular-nums text-slate-400">
                              {{ t('reports.activity.runs', { count: row.runs }, row.runs) }}
                            </span>
                          </div>
                          <div class="flex h-1.5 gap-[2px]">
                            <div
                              v-for="segment in activitySegments(row)"
                              :key="segment.status"
                              class="h-1.5 rounded-full"
                              :class="STATUS_CLASSES[segment.status]"
                              :style="{
                                width: `${segmentPct(segment.count, maxRuns)}%`,
                              }"
                            />
                          </div>
                          <!-- The status counts in text: the reserved status hues are
                               red-green adjacent, so identity is never colour alone. -->
                          <p class="mt-1 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                            <span v-for="segment in activitySegments(row)" :key="segment.status">
                              {{ n(segment.count, 'decimal') }} {{ statusLabel(segment.status) }}
                            </span>
                            <span v-if="row.avgDurationMs != null">
                              ·
                              {{
                                t('reports.activity.avg', { value: formatMs(row.avgDurationMs) })
                              }}
                            </span>
                          </p>
                        </li>
                      </ul>
                      <div
                        class="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500"
                      >
                        <span
                          v-for="status in ['done', 'failed', 'running', 'other'] as const"
                          :key="status"
                          class="flex items-center gap-1"
                        >
                          <span class="h-2 w-2 rounded-sm" :class="STATUS_CLASSES[status]" />{{
                            statusLabel(status)
                          }}
                        </span>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.reports-fade-enter-active,
.reports-fade-leave-active {
  transition: opacity 0.15s ease;
}
.reports-fade-enter-from,
.reports-fade-leave-to {
  opacity: 0;
}
</style>
