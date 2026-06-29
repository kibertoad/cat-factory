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
import { computed, onUnmounted, ref, watch } from 'vue'
import type { TestConcern, TestOutcome, TestReport, TestScreenshot } from '~/types/domain'
import { useArtifactBlobs } from '~/composables/useArtifactBlobs'
import { useFocusTrap } from '~/composables/useFocusTrap'
import ArtifactLightbox from '~/components/media/ArtifactLightbox.vue'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import StepContainerStatus from '~/components/panels/StepContainerStatus.vue'
import EnvironmentStatusPanel from '~/components/environments/EnvironmentStatusPanel.vue'
import ProvisioningLogsDrawer from '~/components/provisioning/ProvisioningLogsDrawer.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const { t, d } = useI18n()

// Per-window blob cache for the captured screenshots; revoked on unmount.
const blobs = useArtifactBlobs()
onUnmounted(() => blobs.revokeAll())

// Shared seam contract (open/blockId/close + Escape). No `onOpen` loader: this window reads
// its report straight off the execution step, so there's nothing to fetch on open.
const { open, blockId, instanceId, stepIndex, close } = useResultView('tester')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const report = computed<TestReport | null>(() => step.value?.test?.lastReport ?? null)
const testState = computed(() => step.value?.test ?? null)
// The inspectable Fixer history: one entry per fixer round (what it was handed + how it
// ended), newest first, so the otherwise-opaque fixer sub-jobs have a surface here.
const fixerAttempts = computed(() => [...(testState.value?.attemptLog ?? [])].reverse())

// Infrastructure observability — parity with the Coder's generic step detail, so the
// Tester window surfaces WHERE its job runs (the container lifecycle: spinning up /
// running phase / id+url / errored), the ephemeral environment it tests against, and the
// run's infrastructure attempts + logs (container/runner/env spin-up), not just the
// report. The container/subtask signals already flow onto the step via the generic poll.
const runFailed = computed(() => instance.value?.status === 'failed')
const stepEnvironment = computed(() => step.value?.environment ?? null)
const executionId = computed(() => instance.value?.id ?? null)
// The infra-attempts log drawer is opened on demand (it fetches the per-run log rows).
const showProvisioning = ref(false)

const screenshots = computed<TestScreenshot[]>(() => report.value?.screenshots ?? [])
// Resolve each capture into an object URL for the gallery + lightbox. The shared cache
// dedupes, so the lightbox reuses what the thumbnails fetched. (The reference design is not
// shown in this window — that's the visual-confirmation gate's job — so we don't fetch it.)
watch(
  screenshots,
  (next) => {
    for (const s of next) void blobs.resolve(s.artifactId)
  },
  { immediate: true },
)

const STATUS_META = computed<
  Record<TestOutcome['status'], { icon: string; text: string; label: string }>
>(() => ({
  passed: {
    icon: 'i-lucide-circle-check',
    text: 'text-emerald-400',
    label: t('testing.status.passed'),
  },
  failed: { icon: 'i-lucide-circle-x', text: 'text-rose-400', label: t('testing.status.failed') },
  skipped: {
    icon: 'i-lucide-circle-minus',
    text: 'text-slate-500',
    label: t('testing.status.skipped'),
  },
}))

// Exhaustive enum→key map for the concern severity chip label (literal keys keep the
// typed-key drift guard live).
const SEVERITY_LABELS = computed<Record<TestConcern['severity'], string>>(() => ({
  critical: t('testing.severity.critical'),
  high: t('testing.severity.high'),
  medium: t('testing.severity.medium'),
  low: t('testing.severity.low'),
}))

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
  screenshots: TestScreenshot[]
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

// Group outcomes + concerns + screenshots under the scenarios the Tester listed in
// `tested`. An item falls under a scenario when their names are related; anything left over
// lands in a synthetic "Other checks" bucket / the standalone gallery so nothing is dropped.
const scenarioLayout = computed<{ groups: ScenarioGroup[]; ungrouped: TestScreenshot[] }>(() => {
  const r = report.value
  if (!r) return { groups: [], ungrouped: [] }
  const outcomes = r.outcomes ?? []
  const concerns = r.concerns ?? []
  const shots = r.screenshots ?? []
  const usedOutcome = new Set<number>()
  const usedConcern = new Set<number>()
  const usedShot = new Set<number>()
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
    const groupShots = shots.filter((s, si) => {
      if (usedShot.has(si)) return false
      if (related(area, s.view) || groupOutcomes.some((o) => related(o.name, s.view))) {
        usedShot.add(si)
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
      screenshots: groupShots,
      status: rollUp(groupOutcomes, groupConcerns),
    })
  })

  const leftoverOutcomes = outcomes.filter((_, oi) => !usedOutcome.has(oi))
  const leftoverConcerns = concerns.filter((_, ci) => !usedConcern.has(ci))
  if (leftoverOutcomes.length || leftoverConcerns.length) {
    out.push({
      key: 'other',
      title: r.tested.length ? t('testing.otherChecks') : t('testing.checks'),
      other: true,
      outcomes: leftoverOutcomes,
      concerns: leftoverConcerns,
      screenshots: [],
      status: rollUp(leftoverOutcomes, leftoverConcerns),
    })
  }
  const ungrouped = shots.filter((_, si) => !usedShot.has(si))
  return { groups: out, ungrouped }
})
const groups = computed(() => scenarioLayout.value.groups)
const ungroupedScreenshots = computed(() => scenarioLayout.value.ungrouped)

// Shared lightbox over ALL captured screenshots (in report order).
const lightboxItems = computed(() =>
  screenshots.value.map((s) => ({
    artifactId: s.artifactId,
    label: s.view,
    alt: t('testing.screenshotAlt', { view: s.view }),
  })),
)
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
function openShot(artifactId: string) {
  const i = lightboxItems.value.findIndex((it) => it.artifactId === artifactId)
  lightboxIndex.value = i < 0 ? 0 : i
  lightboxOpen.value = true
}

// Focus management for the modal panel; hands the Tab trap off to the lightbox while it's open.
const dialogRoot = ref<HTMLElement | null>(null)
useFocusTrap(
  dialogRoot,
  computed(() => open.value && !lightboxOpen.value),
)

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
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        ref="dialogRoot"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        data-testid="tester-report-window"
        :aria-label="t('testing.title')"
        class="m-4 flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl focus:outline-none"
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
              {{ t('testing.title') }}{{ block ? ` — ${block.title}` : '' }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ t('testing.subtitle') }}
            </p>
          </div>
          <UBadge
            v-if="report"
            :color="report.greenlight ? 'success' : 'warning'"
            variant="subtle"
            size="sm"
          >
            {{ report.greenlight ? t('testing.badge.greenlit') : t('testing.badge.needsFixes') }}
          </UBadge>
          <span
            v-if="testState && testState.attempts > 0"
            class="text-[11px] text-slate-400"
            :title="t('testing.fixerAttempts')"
          >
            {{
              t('testing.fixCount', { attempts: testState.attempts, max: testState.maxAttempts })
            }}
            <template v-if="testState.phase === 'fixing'">
              {{ t('testing.fixingSuffix') }}</template
            >
          </span>
          <StepRestartControl
            :instance-id="instanceId"
            :step-index="stepIndex"
            @restarted="close"
          />
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <!-- Main: infrastructure observability + scenarios → outcomes → concerns tree -->
          <div class="min-w-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <!-- Infrastructure: container lifecycle (where + what it's doing), the
                 ephemeral environment, and the run's infra attempts + logs — parity with
                 the Coder's step detail. Shown even before a report lands, so the infra
                 spin-up is visible WHILE the Tester is still standing it up. -->
            <!-- Only when there's genuine infrastructure to show — a container or an ephemeral
                 environment. A no-infra tester (no container, no env) has no infra attempts
                 either, so we don't render an empty header + a log toggle over nothing. -->
            <section
              v-if="step && (step.container || stepEnvironment)"
              data-testid="tester-infrastructure"
              class="space-y-3"
            >
              <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('testing.infrastructure') }}
              </h3>
              <StepContainerStatus :step="step" :run-failed="runFailed" />
              <EnvironmentStatusPanel v-if="stepEnvironment" :environment="stepEnvironment" />
              <div v-if="executionId">
                <UButton
                  :icon="showProvisioning ? 'i-lucide-chevron-up' : 'i-lucide-scroll-text'"
                  variant="ghost"
                  size="xs"
                  data-testid="tester-infra-attempts-toggle"
                  @click="showProvisioning = !showProvisioning"
                >
                  {{
                    showProvisioning
                      ? t('panels.stepDetail.hideInfraAttempts')
                      : t('panels.stepDetail.infraAttempts')
                  }}
                </UButton>
                <ProvisioningLogsDrawer
                  v-if="showProvisioning"
                  class="mt-2"
                  :execution-id="executionId"
                />
              </div>
            </section>

            <!-- Fixer timeline: one inspectable entry per fixer round (what it was handed and
                 how it ended), so the otherwise-opaque fixer sub-jobs have a surface — the
                 analogue of the polling gate's attempt history. -->
            <section
              v-if="fixerAttempts.length"
              data-testid="tester-fixer-attempts"
              class="space-y-2"
            >
              <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('testing.fixerAttempts') }}
              </h3>
              <ol class="space-y-2">
                <li
                  v-for="a in fixerAttempts"
                  :key="a.attempt"
                  data-testid="tester-fixer-attempt"
                  class="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2"
                >
                  <div class="flex items-center gap-2">
                    <UIcon
                      :name="a.outcome === 'completed' ? 'i-lucide-wrench' : 'i-lucide-circle-x'"
                      class="h-3.5 w-3.5 shrink-0"
                      :class="a.outcome === 'completed' ? 'text-amber-300' : 'text-rose-400'"
                    />
                    <span class="text-[13px] font-medium text-slate-200">
                      {{ t('testing.fixerTimeline.attempt', { n: a.attempt }) }}
                    </span>
                    <UBadge
                      :color="a.outcome === 'completed' ? 'neutral' : 'error'"
                      variant="subtle"
                      size="sm"
                    >
                      {{
                        a.outcome === 'completed'
                          ? t('testing.fixerTimeline.completed')
                          : t('testing.fixerTimeline.failed')
                      }}
                    </UBadge>
                    <span class="ml-auto text-[11px] text-slate-500">{{
                      d(new Date(a.at), 'short')
                    }}</span>
                  </div>
                  <p v-if="a.summary" class="mt-1 text-[12px] leading-snug text-slate-400">
                    {{ a.summary }}
                  </p>
                  <div v-if="a.concerns && a.concerns.length" class="mt-1.5">
                    <p class="text-[11px] text-slate-500">
                      {{ t('testing.fixerTimeline.addressed') }}
                    </p>
                    <ul class="mt-1 space-y-0.5">
                      <li
                        v-for="(c, ci) in a.concerns"
                        :key="`fa${a.attempt}-c${ci}`"
                        class="flex items-center gap-1.5 text-[12px] text-slate-300"
                      >
                        <span
                          class="rounded px-1 text-[10px] uppercase"
                          :class="SEVERITY_META[c.severity].chip"
                          >{{ SEVERITY_LABELS[c.severity] }}</span
                        >
                        <span class="truncate">{{ c.title }}</span>
                      </li>
                    </ul>
                  </div>
                </li>
              </ol>
            </section>

            <div
              v-if="!report"
              class="flex flex-col items-center justify-center gap-2 py-12 text-center text-slate-400"
            >
              <UIcon name="i-lucide-flask-conical" class="h-8 w-8 opacity-40" />
              <p class="text-sm">{{ t('testing.empty.title') }}</p>
              <p class="max-w-sm text-[11px] text-slate-500">
                {{ t('testing.empty.hint') }}
              </p>
            </div>

            <template v-else>
              <!-- Summary -->
              <p v-if="report.summary" class="mb-4 text-[13px] leading-relaxed text-slate-300">
                {{ report.summary }}
              </p>

              <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('testing.scenariosOutcomes') }}
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
                    <UIcon
                      v-if="g.screenshots.length"
                      name="i-lucide-camera"
                      class="h-3.5 w-3.5 shrink-0 text-slate-500"
                      :title="
                        t(
                          'testing.screenshotCount',
                          { count: g.screenshots.length },
                          g.screenshots.length,
                        )
                      "
                    />
                    <span class="shrink-0 text-[11px] text-slate-500">
                      {{ t('testing.checkCount', { count: g.outcomes.length }, g.outcomes.length) }}
                      <template v-if="g.concerns.length">
                        ·
                        {{
                          t('testing.concernCount', { count: g.concerns.length }, g.concerns.length)
                        }}
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
                      {{ t('testing.noDiscreteCheck') }}
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
                            {{ SEVERITY_LABELS[c.severity] }}
                          </span>
                        </div>
                        <p v-if="c.detail" class="text-[12px] leading-snug text-slate-400">
                          {{ c.detail }}
                        </p>
                      </div>
                    </div>

                    <!-- Screenshots captured for this scenario -->
                    <div v-if="g.screenshots.length" class="mt-2 flex flex-wrap gap-2">
                      <button
                        v-for="(s, si) in g.screenshots"
                        :key="`shot${si}`"
                        class="group relative h-20 w-28 shrink-0 overflow-hidden rounded border border-slate-800 bg-slate-950/60 hover:border-slate-600"
                        :title="s.view"
                        @click="openShot(s.artifactId)"
                      >
                        <img
                          v-if="blobs.urlFor(s.artifactId)"
                          :src="blobs.urlFor(s.artifactId)"
                          :alt="t('testing.screenshotAlt', { view: s.view })"
                          class="h-full w-full object-cover object-top"
                        />
                        <span
                          v-else
                          class="flex h-full w-full items-center justify-center text-[10px] text-slate-600"
                        >
                          {{
                            blobs.statusFor(s.artifactId) === 'error'
                              ? t('testing.shot.failed')
                              : t('testing.shot.loading')
                          }}
                        </span>
                        <span
                          class="absolute inset-x-0 bottom-0 truncate bg-slate-950/80 px-1 py-0.5 text-[9px] text-slate-300"
                          >{{ s.view }}</span
                        >
                      </button>
                    </div>
                  </div>
                </li>
              </ul>

              <!-- Standalone gallery: any captures not mapped to a scenario above -->
              <section v-if="ungroupedScreenshots.length" class="mt-5">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('testing.screenshots') }}
                </h3>
                <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <button
                    v-for="(s, si) in ungroupedScreenshots"
                    :key="`gal${si}`"
                    class="group relative aspect-video overflow-hidden rounded-lg border border-slate-800 bg-slate-950/60 hover:border-slate-600"
                    :title="s.view"
                    @click="openShot(s.artifactId)"
                  >
                    <img
                      v-if="blobs.urlFor(s.artifactId)"
                      :src="blobs.urlFor(s.artifactId)"
                      :alt="t('testing.screenshotAlt', { view: s.view })"
                      class="h-full w-full object-cover object-top"
                    />
                    <span
                      v-else
                      class="flex h-full w-full items-center justify-center text-[11px] text-slate-600"
                    >
                      {{
                        blobs.statusFor(s.artifactId) === 'error'
                          ? t('testing.shot.failedToLoad')
                          : t('testing.shot.loading')
                      }}
                    </span>
                    <span
                      class="absolute inset-x-0 bottom-0 truncate bg-slate-950/80 px-1.5 py-0.5 text-[10px] text-slate-300"
                      >{{ s.view }}</span
                    >
                  </button>
                </div>
              </section>
            </template>
          </div>

          <!-- Sidebar: metadata -->
          <aside
            class="hidden w-60 shrink-0 flex-col gap-4 border-l border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
          >
            <div v-if="report">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('testing.verdict.heading') }}
              </h4>
              <div class="flex items-center gap-2 text-[13px]">
                <UIcon
                  :name="report.greenlight ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                  class="h-4 w-4"
                  :class="report.greenlight ? 'text-emerald-400' : 'text-rose-400'"
                />
                <span :class="report.greenlight ? 'text-emerald-300' : 'text-rose-300'">
                  {{
                    report.greenlight ? t('testing.verdict.safe') : t('testing.verdict.withheld')
                  }}
                </span>
              </div>
            </div>

            <div v-if="report">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('testing.outcomes.heading') }}
              </h4>
              <dl class="space-y-1 text-[12px]">
                <div class="flex items-center justify-between">
                  <dt class="text-slate-400">{{ t('testing.outcomes.passed') }}</dt>
                  <dd class="text-emerald-300">{{ counts.passed }}</dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-slate-400">{{ t('testing.outcomes.failed') }}</dt>
                  <dd class="text-rose-300">{{ counts.failed }}</dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-slate-400">{{ t('testing.outcomes.skipped') }}</dt>
                  <dd class="text-slate-300">{{ counts.skipped }}</dd>
                </div>
                <div class="flex items-center justify-between border-t border-slate-800 pt-1">
                  <dt class="text-slate-400">{{ t('testing.outcomes.concerns') }}</dt>
                  <dd class="text-amber-300">
                    {{ counts.concerns
                    }}<template v-if="counts.blocking">
                      {{
                        t('testing.outcomes.blocking', { count: counts.blocking }, counts.blocking)
                      }}</template
                    >
                  </dd>
                </div>
              </dl>
            </div>

            <div v-if="report?.environment">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('testing.environment') }}
              </h4>
              <p class="text-[12px] capitalize text-slate-300">{{ report.environment }}</p>
            </div>

            <!-- Shared run metadata + embedded observability (model, run id, timing,
                 model-activity rollup) — identical to the gate and agent step detail. -->
            <StepRunMeta
              v-if="step"
              :step="step"
              :instance-id="instanceId ?? undefined"
              :step-number="stepIndex === null ? undefined : stepIndex + 1"
              :total-steps="instance?.steps.length"
              :run-failed="instance?.status === 'failed'"
              :failure-at="instance?.failure?.occurredAt"
            />

            <p class="mt-auto text-[10px] leading-relaxed text-slate-600">
              {{ t('testing.footer') }}
            </p>
          </aside>
        </div>
      </div>
    </div>

    <!-- Shared zoom/pan viewer for the captured screenshots. -->
    <ArtifactLightbox
      v-model:open="lightboxOpen"
      v-model:index="lightboxIndex"
      :items="lightboxItems"
      :blobs="blobs"
    />
  </Teleport>
</template>
