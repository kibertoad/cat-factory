<script setup lang="ts">
// Test-report window — the dedicated surface for a `tester` step's structured report
// (opened via the universal result-view host, the same seam the requirements review
// uses). It renders the report as a hierarchical tree: the scenarios the Tester chose
// to exercise (its `tested` areas, which map to the spec's acceptance scenarios) →
// the per-area outcomes (passed / failed / skipped) → the concerns linked to them,
// plus the overall greenlight verdict and the Tester→Fixer loop state.
//
// The service spec is not exposed to the SPA, so "linked spec elements" are derived
// from the report itself: each `tested` entry is the scenario the Tester walked, and
// outcomes / concerns are grouped under it by name. Deeper linkage to the in-repo
// `spec/features/*.feature` files would need a spec endpoint (a future enhancement).
import type { TestConcern, TestOutcome, TestReport } from '~/types/domain'

const ui = useUiStore()
const board = useBoardStore()
const execution = useExecutionStore()

const open = computed(() => ui.resultView?.view === 'tester')
const blockId = computed(() => ui.resultView?.blockId ?? null)
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

const step = computed(() => {
  const rv = ui.resultView
  if (!rv || rv.view !== 'tester' || rv.instanceId === null || rv.stepIndex === null) return null
  return execution.getInstance(rv.instanceId)?.steps[rv.stepIndex] ?? null
})
const report = computed<TestReport | null>(() => step.value?.test?.lastReport ?? null)
const testState = computed(() => step.value?.test ?? null)

function close() {
  ui.closeResultView()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const STATUS_META: Record<TestOutcome['status'], { icon: string; text: string; label: string }> = {
  passed: { icon: 'i-lucide-circle-check', text: 'text-emerald-400', label: 'Passed' },
  failed: { icon: 'i-lucide-circle-x', text: 'text-rose-400', label: 'Failed' },
  skipped: { icon: 'i-lucide-circle-minus', text: 'text-slate-500', label: 'Skipped' },
}

const SEVERITY_META: Record<TestConcern['severity'], { text: string; chip: string; rank: number }> =
  {
    critical: { text: 'text-rose-300', chip: 'bg-rose-500/15 text-rose-300', rank: 0 },
    high: { text: 'text-rose-300', chip: 'bg-rose-500/15 text-rose-300', rank: 1 },
    medium: { text: 'text-amber-300', chip: 'bg-amber-500/15 text-amber-300', rank: 2 },
    low: { text: 'text-slate-300', chip: 'bg-slate-500/15 text-slate-300', rank: 3 },
  }

/** Case-insensitive "these two labels refer to the same thing" heuristic. */
function related(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}

interface ScenarioGroup {
  key: string
  title: string
  /** true for the synthetic catch-all bucket of unmatched checks. */
  other: boolean
  outcomes: TestOutcome[]
  concerns: TestConcern[]
  status: 'passed' | 'failed' | 'skipped' | 'mixed' | 'empty'
}

/** Roll the per-area outcomes + concerns into one status for the scenario node. */
function rollUp(outcomes: TestOutcome[], concerns: TestConcern[]): ScenarioGroup['status'] {
  const blocking = concerns.some((c) => c.severity === 'high' || c.severity === 'critical')
  if (outcomes.some((o) => o.status === 'failed') || blocking) return 'failed'
  if (!outcomes.length) return concerns.length ? 'mixed' : 'empty'
  if (outcomes.every((o) => o.status === 'passed')) return 'passed'
  if (outcomes.every((o) => o.status === 'skipped')) return 'skipped'
  return 'mixed'
}

// Group outcomes + concerns under the scenarios the Tester listed in `tested`. An
// outcome/concern falls under a scenario when their names are related; anything left
// over lands in a synthetic "Other checks" bucket so nothing is dropped.
const groups = computed<ScenarioGroup[]>(() => {
  const r = report.value
  if (!r) return []
  const outcomes = r.outcomes ?? []
  const concerns = r.concerns ?? []
  const usedOutcome = new Set<number>()
  const usedConcern = new Set<number>()
  const out: ScenarioGroup[] = []

  r.tested.forEach((area, i) => {
    const groupOutcomes = outcomes.filter((o, oi) => {
      if (usedOutcome.has(oi)) return false
      if (related(area, o.name)) {
        usedOutcome.add(oi)
        return true
      }
      return false
    })
    const groupConcerns = concerns.filter((c, ci) => {
      if (usedConcern.has(ci)) return false
      if (related(area, c.title) || groupOutcomes.some((o) => related(o.name, c.title))) {
        usedConcern.add(ci)
        return true
      }
      return false
    })
    out.push({
      key: `s${i}`,
      title: area,
      other: false,
      outcomes: groupOutcomes,
      concerns: groupConcerns,
      status: rollUp(groupOutcomes, groupConcerns),
    })
  })

  const leftoverOutcomes = outcomes.filter((_, oi) => !usedOutcome.has(oi))
  const leftoverConcerns = concerns.filter((_, ci) => !usedConcern.has(ci))
  if (leftoverOutcomes.length || leftoverConcerns.length) {
    out.push({
      key: 'other',
      title: r.tested.length ? 'Other checks' : 'Checks',
      other: true,
      outcomes: leftoverOutcomes,
      concerns: leftoverConcerns,
      status: rollUp(leftoverOutcomes, leftoverConcerns),
    })
  }
  return out
})

const sortedConcerns = computed<TestConcern[]>(() => {
  const r = report.value
  if (!r) return []
  return [...r.concerns].sort(
    (a, b) => SEVERITY_META[a.severity].rank - SEVERITY_META[b.severity].rank,
  )
})

const counts = computed(() => {
  const r = report.value
  const o = r?.outcomes ?? []
  return {
    passed: o.filter((x) => x.status === 'passed').length,
    failed: o.filter((x) => x.status === 'failed').length,
    skipped: o.filter((x) => x.status === 'skipped').length,
    concerns: r?.concerns.length ?? 0,
    blocking: (r?.concerns ?? []).filter((c) => c.severity === 'high' || c.severity === 'critical')
      .length,
  }
})

// Expand/collapse per scenario node; default everything open.
const collapsed = ref<Set<string>>(new Set())
function toggle(key: string) {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

const GROUP_STATUS_META: Record<ScenarioGroup['status'], { icon: string; text: string }> = {
  passed: { icon: 'i-lucide-circle-check', text: 'text-emerald-400' },
  failed: { icon: 'i-lucide-circle-x', text: 'text-rose-400' },
  skipped: { icon: 'i-lucide-circle-minus', text: 'text-slate-500' },
  mixed: { icon: 'i-lucide-circle-dot', text: 'text-amber-400' },
  empty: { icon: 'i-lucide-circle-dashed', text: 'text-slate-500' },
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300"
          >
            <UIcon name="i-lucide-flask-conical" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              Test report{{ block ? ` — ${block.title}` : '' }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              Exploratory + regression testing of the change
            </p>
          </div>
          <UBadge
            v-if="report"
            :color="report.greenlight ? 'success' : 'warning'"
            variant="subtle"
            size="sm"
          >
            {{ report.greenlight ? 'Greenlit' : 'Needs fixes' }}
          </UBadge>
          <span
            v-if="testState && testState.attempts > 0"
            class="text-[11px] text-slate-400"
            :title="'Fixer attempts'"
          >
            {{ testState.attempts }}/{{ testState.maxAttempts }} fix
            <template v-if="testState.phase === 'fixing'"> · fixing…</template>
          </span>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <!-- Main: scenarios → outcomes → concerns tree -->
          <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            <div
              v-if="!report"
              class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
            >
              <UIcon name="i-lucide-flask-conical" class="h-8 w-8 opacity-40" />
              <p class="text-sm">No test report yet.</p>
              <p class="max-w-sm text-[11px] text-slate-500">
                The report appears once the Tester finishes a pass. While it runs, the step shows
                live progress on the board.
              </p>
            </div>

            <template v-else>
              <!-- Summary -->
              <p v-if="report.summary" class="mb-4 text-[13px] leading-relaxed text-slate-300">
                {{ report.summary }}
              </p>

              <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Scenarios &amp; outcomes
              </h3>
              <ul class="space-y-2">
                <li
                  v-for="g in groups"
                  :key="g.key"
                  class="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60"
                >
                  <button
                    class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/40"
                    @click="toggle(g.key)"
                  >
                    <UIcon
                      :name="
                        collapsed.has(g.key) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'
                      "
                      class="h-3.5 w-3.5 shrink-0 text-slate-500"
                    />
                    <UIcon
                      :name="GROUP_STATUS_META[g.status].icon"
                      class="h-4 w-4 shrink-0"
                      :class="GROUP_STATUS_META[g.status].text"
                    />
                    <span
                      class="min-w-0 flex-1 truncate text-[13px]"
                      :class="g.other ? 'text-slate-400' : 'font-medium text-slate-200'"
                    >
                      {{ g.title }}
                    </span>
                    <span class="shrink-0 text-[11px] text-slate-500">
                      {{ g.outcomes.length }} check{{ g.outcomes.length === 1 ? '' : 's' }}
                      <template v-if="g.concerns.length">
                        · {{ g.concerns.length }} concern{{ g.concerns.length === 1 ? '' : 's' }}
                      </template>
                    </span>
                  </button>

                  <div v-if="!collapsed.has(g.key)" class="space-y-1 px-3 pb-3 pl-9">
                    <!-- Outcomes -->
                    <div
                      v-for="(o, oi) in g.outcomes"
                      :key="`o${oi}`"
                      class="flex items-start gap-2 py-0.5"
                    >
                      <UIcon
                        :name="STATUS_META[o.status].icon"
                        class="mt-0.5 h-3.5 w-3.5 shrink-0"
                        :class="STATUS_META[o.status].text"
                      />
                      <div class="min-w-0">
                        <span class="text-[13px] text-slate-200">{{ o.name }}</span>
                        <p v-if="o.detail" class="text-[12px] leading-snug text-slate-400">
                          {{ o.detail }}
                        </p>
                      </div>
                    </div>
                    <p v-if="!g.outcomes.length" class="py-0.5 text-[12px] italic text-slate-500">
                      No discrete check recorded for this scenario.
                    </p>

                    <!-- Concerns linked to this scenario -->
                    <div
                      v-for="(c, ci) in g.concerns"
                      :key="`c${ci}`"
                      class="mt-1 flex items-start gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1.5"
                    >
                      <UIcon
                        name="i-lucide-alert-triangle"
                        class="mt-0.5 h-3.5 w-3.5 shrink-0"
                        :class="SEVERITY_META[c.severity].text"
                      />
                      <div class="min-w-0">
                        <div class="flex items-center gap-1.5">
                          <span class="text-[12px] font-medium text-slate-200">{{ c.title }}</span>
                          <span
                            class="rounded px-1 text-[10px] uppercase"
                            :class="SEVERITY_META[c.severity].chip"
                          >
                            {{ c.severity }}
                          </span>
                        </div>
                        <p v-if="c.detail" class="text-[12px] leading-snug text-slate-400">
                          {{ c.detail }}
                        </p>
                      </div>
                    </div>
                  </div>
                </li>
              </ul>
            </template>
          </div>

          <!-- Sidebar: metadata -->
          <aside
            class="hidden w-60 shrink-0 flex-col gap-4 border-l border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
          >
            <div v-if="report">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Verdict
              </h4>
              <div class="flex items-center gap-2 text-[13px]">
                <UIcon
                  :name="report.greenlight ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                  class="h-4 w-4"
                  :class="report.greenlight ? 'text-emerald-400' : 'text-rose-400'"
                />
                <span :class="report.greenlight ? 'text-emerald-300' : 'text-rose-300'">
                  {{ report.greenlight ? 'Safe to release' : 'Withheld' }}
                </span>
              </div>
            </div>

            <div v-if="report">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Outcomes
              </h4>
              <dl class="space-y-1 text-[12px]">
                <div class="flex items-center justify-between">
                  <dt class="text-slate-400">Passed</dt>
                  <dd class="text-emerald-300">{{ counts.passed }}</dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-slate-400">Failed</dt>
                  <dd class="text-rose-300">{{ counts.failed }}</dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-slate-400">Skipped</dt>
                  <dd class="text-slate-300">{{ counts.skipped }}</dd>
                </div>
                <div class="flex items-center justify-between border-t border-slate-800 pt-1">
                  <dt class="text-slate-400">Concerns</dt>
                  <dd class="text-amber-300">
                    {{ counts.concerns
                    }}<template v-if="counts.blocking"> ({{ counts.blocking }} blocking)</template>
                  </dd>
                </div>
              </dl>
            </div>

            <div v-if="report?.environment">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Environment
              </h4>
              <p class="text-[12px] capitalize text-slate-300">{{ report.environment }}</p>
            </div>

            <div v-if="step?.model">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Model
              </h4>
              <p class="break-all text-[12px] text-slate-300">{{ step.model }}</p>
            </div>

            <p class="mt-auto text-[10px] leading-relaxed text-slate-600">
              Scenarios are the areas the Tester chose to exercise (its spec acceptance scenarios).
              Outcomes and concerns are grouped under them by name.
            </p>
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>
