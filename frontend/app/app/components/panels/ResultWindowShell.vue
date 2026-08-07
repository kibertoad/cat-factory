<script setup lang="ts">
// Shared modal shell for the agent-run result windows (slice 5 of the modular-vue
// adoption — backend/docs/adr/0049-modular-vue-adoption.md; progress in
// backend/docs/adr/0049-modular-vue-adoption.md).
//
// Every result window (the merger verdict, the tester report, the requirements-review
// loop, the gates, …) used to hand-roll the SAME modal chrome — `<Teleport>`, a
// backdrop, a bordered card, a header row with an icon/title/close — and, worse,
// re-implemented the modal *behaviour* inconsistently: only 2 of ~18 trapped focus, each
// registered its own global Escape listener, and every one hard-coded `z-50` with no
// stacking. This shell centralises the chrome AND delegates the behaviour to the upstream
// `useModalBehavior` (`@modular-vue/core`, the slice-5 overlay-host release): focus-trap
// + focus-return, body-scroll lock, and a shared overlay STACK so the top overlay closes
// first on Escape. A window becomes body-only markup wrapped in `<ResultWindowShell>`; it
// keeps its `useResultView` seam (Escape lives in this shell now, not in `useResultView`).
//
// The pick-one SELECTION of which window is active stays exactly the slice-2
// `resolveComponentRegistry` in `StepResultViewHost.vue` — this shell only owns the
// per-window chrome + behaviour, so windows convert one at a time behind it.
//
// It also owns the one trailing section every step-backed window shows: the agent's effort
// self-assessment (see the footer block below), so a window never renders it itself.
import { computed, ref, watch } from 'vue'
import { useModalBehavior } from '@modular-vue/core'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'
import StepEffortReport from '~/components/panels/StepEffortReport.vue'
import StepValidationReport from '~/components/panels/StepValidationReport.vue'
import StepReproductionReport from '~/components/panels/StepReproductionReport.vue'
import BinaryOutputReport from '~/components/binaryOutput/BinaryOutputReport.vue'
import { REPRODUCTION_STATUS_KEYS } from '~/utils/reproduction'
import {
  BINARY_OUTPUT_STATE_KEYS,
  binaryOutputHasWarnings,
  binaryOutputView,
} from '~/utils/binaryOutput'
import { effortBand, effortHint } from '~/utils/effort'
import {
  RESULT_WINDOW_WIDTH_CLASS,
  type ResultWindowWidth,
} from '~/components/panels/ResultWindowShell.logic'

/** A pipeline step reference — passed by step-result windows to surface the shared
 *  "restart from here" control. `StepRestartControl` self-hides for an off-path open
 *  (null ids), so a block-keyed window simply omits this prop. */
type StepRef = { instanceId: string | null; stepIndex: number | null }

const props = withDefaults(
  defineProps<{
    /** Whether the window is open — drives the modal behaviour's activation. */
    open: boolean
    /** Header icon (a `UIcon` name) + its badge colour classes. */
    icon?: string
    iconClass?: string
    /** Header title (the accessible dialog name) + optional secondary line. */
    title: string
    subtitle?: string
    /**
     * Card width bucket + backdrop layout (the two pre-slice-5 chrome variants).
     *
     * `full` is the REVIEW/READING bucket: the panel takes the whole viewport minus the
     * shell's own gutter, the shape the full-bleed step reader (`AgentStepDetail`) already
     * has. It is for a window whose body lays out in COLUMNS — rails plus a fluid main
     * column — where the width buys visible layout: the outline and the review rail stop
     * competing with the document, a findings list stops wrapping every card, a diff or a
     * results table stops scrolling sideways. A window that is one column of prose or a
     * short verdict keeps a bucket: stretching two paragraphs across an ultrawide reads
     * worse, not better.
     *
     * The obligation that comes with it: CONTINUOUS PROSE inside a `full` window carries its
     * own reading measure (`PROSE_MEASURE_CLASS`, the step reader's own, over the same 13px
     * `.reader-prose`), or the width lands as 200-character lines.
     *
     * The unit that obligation attaches to is the PARAGRAPH, not the section — which is the
     * distinction to get right, because "a findings list reads better at the full span" is
     * true of the LIST and false of the prose inside each row. A list's rows, badge rows,
     * control rows, tables, Gherkin blocks, log tails and inputs all take the span; a
     * finding's detail, a recorded answer, an investigator's justification and a summary
     * paragraph are prose wherever they sit, and take the measure. Sizing by section is how a
     * card whose answer control is STACKED under its question — every finding card here —
     * ends up arguing that its question is "beside" something and keeping 200-character lines.
     *
     * What `full` costs: click-outside effectively goes, since the backdrop is then only the
     * shell's own gutter. That is the same trade the full-bleed reader already makes (it has
     * no backdrop close at all), and Escape plus the header's close button — the two paths a
     * keyboard and a pointer user actually reach for — are untouched. A window that wants
     * click-outside to stay hittable is a window that should have kept a bucket.
     */
    width?: ResultWindowWidth
    variant?: 'stretch' | 'centered'
    /** Provide on step-result windows to show the shared restart control; omit on gates
     *  and block-keyed windows (no restart mid-gate / pre-run). */
    stepRef?: StepRef
    /** `data-testid` on the dialog root — pass a window's existing id to preserve e2e
     *  selectors; defaults to `result-window`. */
    testid?: string
  }>(),
  {
    icon: 'i-lucide-square',
    iconClass: 'bg-slate-500/15 text-slate-300',
    subtitle: undefined,
    width: '3xl',
    variant: 'stretch',
    stepRef: undefined,
    testid: undefined,
  },
)

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

function requestClose() {
  emit('close')
}

// Managed modal behaviour (focus-trap + return, scroll lock, shared-stack Escape). The
// window unmounts on close, so deactivation + cleanup fire via `active` going false and
// unmount — no manual teardown here.
const { dialogRef } = useModalBehavior({
  active: () => props.open,
  onClose: requestClose,
})

// The active step's effort self-assessment (how hard the work was, what reduced its
// effectiveness, the obstacles it hit), rendered as a collapsible footer under EVERY window.
// Resolved from the result-view seam itself rather than a per-window prop: the host mounts
// exactly one window — the active `ui.resultView` — so a window can't opt out, forget to pass
// it, or drift in where it puts it. An off-path open (a block-keyed window with no step) and a
// step whose agent wrote no report both resolve to null, and the footer disappears.
const ui = useUiStore()
const execution = useExecutionStore()
const activeStep = computed(() => {
  const view = ui.resultView
  if (!view || view.instanceId === null || view.stepIndex === null) return null
  return execution.getInstance(view.instanceId)?.steps[view.stepIndex] ?? null
})
const effortReport = computed(() => activeStep.value?.effortReport ?? null)
// The step's PRE-PR VALIDATION report — the second universal trailing section, resolved the same
// way and for the same reason: every window whose step ran a coding job can show whether the
// checkout actually passed the service's checks before the PR opened (and, on a red run, exactly
// what failed). Absent for a service that configured no checks, and the footer disappears.
const validationReport = computed(() => activeStep.value?.validation ?? null)
const validationOpen = ref(false)
// A failing report is the interesting one, so it opens expanded; a green one stays a one-line row.
watch(
  validationReport,
  (report) => {
    if (report && !report.passed) validationOpen.value = true
  },
  { immediate: true },
)
/**
 * The step's BUGFIX REPRODUCTION PROOF — resolved off the active step for the same reason as the
 * three sections around it: the engine writes it onto whichever step OPENED the pull request, which
 * is a property of the dispatch rather than of the step's own kind, so no window may be able to opt
 * out of showing it. Absent for every run that declared no reproducing check, and the section
 * disappears.
 */
const reproductionReport = computed(() => activeStep.value?.reproduction ?? null)
const reproductionOpen = ref(false)
// Anything short of proof opens expanded: an `inconclusive` verdict and a structural infeasibility
// declaration are both things a reviewer has to read and weigh, where `reproduced` is the one
// answer a collapsed one-line row states completely.
watch(
  reproductionReport,
  (report) => {
    if (report && report.status !== 'reproduced') reproductionOpen.value = true
  },
  { immediate: true },
)
/**
 * The verdict's copy, icon and tone, from the EXHAUSTIVE lookup keyed off the contracts union
 * rather than a t() call over a key assembled at runtime: the typed-key check cannot see such a
 * key, so a fourth verdict would ship as a blank chip on the surface whose whole job is saying what
 * was and was not proven.
 */
const reproductionKeys = computed(() =>
  reproductionReport.value ? REPRODUCTION_STATUS_KEYS[reproductionReport.value.status] : null,
)
/**
 * The step's BINARY-OUTPUT record — the third universal trailing section, and here for the same
 * reason as the two above: it is a by-product recorded on the STEP, not the deliverable of any
 * one window, so no window may be able to opt out of it.
 *
 * The alternative — a dedicated `binary-outputs` result view a generator kind declares — cannot
 * cover the record's own scope. The engine writes this report whenever the step's kind carries
 * the trait OR the step carries a selection (`stepMayDeclareBinaryOutputs`, the deliberate UNION),
 * precisely so a trait-carrying kind dispatched under an OVERRIDING kind still has its artifacts
 * recorded. A kind-declared view is by construction blind to that case: the step's own kind
 * declares a different window, and the artifacts exist with nowhere showing them. Resolving off
 * the active step instead makes the surface follow the record rather than the catalog — and it
 * leaves a generator free to declare a result view for its OWN output, which is what a generator
 * that produces prose AND artifacts actually wants.
 *
 * Absent for every stock step (no report, no selection) and the section disappears, exactly as
 * the two above do. That absence is the honest "this step had no binary-output story" — the
 * distinct states that ARE a story (declared nothing / never declared / unreadable) all render.
 */
const binaryOutputs = computed(() => binaryOutputView(activeStep.value))
const binaryOutputsOpen = ref(false)
// A record carrying losses (unknown ids, dropped entries, a truncated list, an artifact that
// went somewhere else) opens expanded — collapsed, it would read exactly like a clean one.
watch(
  binaryOutputs,
  (view) => {
    if (view && binaryOutputHasWarnings(view)) binaryOutputsOpen.value = true
  },
  { immediate: true },
)

/**
 * The collapsed row's line: the OUTCOME, plus the artifact count only when there are artifacts.
 * Deliberately not "N artifacts" for every state — five of the six have none, and a `0` there
 * would render "declared nothing", "never declared" and "unreadable declaration" identically,
 * which is the exact conflation the report's bookkeeping exists to prevent.
 */
const binaryOutputSummary = computed(() => {
  const view = binaryOutputs.value
  if (!view) return ''
  const outcome = t(BINARY_OUTPUT_STATE_KEYS[view.state].summary)
  return view.state === 'stored'
    ? t('binaryOutput.storedCount', { outcome, count: view.rows.length }, view.rows.length)
    : outcome
})

// Collapsed by default — the windows own the vertical space, and the row already carries the
// difficulty plus the gist of what held the agent back.
const effortOpen = ref(false)
const hint = computed(() => (effortReport.value ? effortHint(effortReport.value) : null))
const CHIP_CLASS = {
  easy: 'bg-emerald-500/15 text-emerald-300',
  moderate: 'bg-amber-500/15 text-amber-300',
  hard: 'bg-rose-500/15 text-rose-300',
} as const
const chipClass = computed(() =>
  effortReport.value ? CHIP_CLASS[effortBand(effortReport.value.difficulty)] : '',
)

const backdropClass = computed(() => [
  'fixed inset-0 z-50 flex max-h-[100dvh] justify-center bg-slate-950/70 backdrop-blur-sm',
  props.variant === 'centered' ? 'items-center p-4' : 'items-stretch',
])
const panelClass = computed(() => [
  'flex w-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl',
  RESULT_WINDOW_WIDTH_CLASS[props.width],
  props.variant === 'centered' ? 'max-h-[90dvh]' : 'm-4',
])
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      :class="backdropClass"
      data-testid="result-window-backdrop"
      @click.self="requestClose"
    >
      <div
        ref="dialogRef"
        tabindex="-1"
        :class="panelClass"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :data-testid="testid ?? 'result-window'"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            :class="iconClass"
          >
            <UIcon :name="icon" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">{{ title }}</h2>
            <p v-if="subtitle" class="truncate text-[11px] text-slate-400">{{ subtitle }}</p>
          </div>
          <!-- Window-specific header content (status badges, counts). -->
          <slot name="header-extras" />
          <StepRestartControl
            v-if="stepRef"
            :instance-id="stepRef.instanceId"
            :step-index="stepRef.stepIndex"
            @restarted="requestClose"
          />
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            data-testid="result-window-close"
            :aria-label="t('common.close')"
            @click="requestClose"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>
        <!-- The window body. -->
        <slot />

        <!-- Shared trailing section: the container agent's effort self-assessment, under the
             window's own detail. Collapsed to a one-line row (difficulty + what held it back)
             so it can't crowd a window out; expands in place. -->
        <section
          v-if="effortReport"
          class="shrink-0 border-t border-slate-800 bg-slate-900/60"
          data-testid="result-window-effort"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-5 py-2 text-start hover:bg-slate-800/40"
            :aria-expanded="effortOpen"
            data-testid="result-window-effort-toggle"
            @click="effortOpen = !effortOpen"
          >
            <UIcon name="i-lucide-gauge" class="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('panels.stepDetail.effort.heading') }}
            </span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
              :class="chipClass"
            >
              {{ t('panels.stepDetail.effort.outOfTen', { value: effortReport.difficulty }) }}
            </span>
            <span v-if="hint" class="min-w-0 flex-1 truncate text-[12px] text-slate-400">
              {{ hint }}
            </span>
            <UIcon
              :name="effortOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
              class="ms-auto h-3.5 w-3.5 shrink-0 text-slate-500"
            />
          </button>
          <div v-if="effortOpen" class="max-h-56 overflow-y-auto px-5 pb-3">
            <StepEffortReport :report="effortReport" variant="flat" />
          </div>
        </section>

        <!-- Shared trailing section: the pre-PR validation report (the service's check commands
             run against the checkout BEFORE the PR opened). Collapsed when green, expanded when
             red — a failed checkout is the one an operator opened the window to read. -->
        <section
          v-if="validationReport"
          class="shrink-0 border-t border-slate-800 bg-slate-900/60"
          data-testid="result-window-validation"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-5 py-2 text-start hover:bg-slate-800/40"
            :aria-expanded="validationOpen"
            data-testid="result-window-validation-toggle"
            @click="validationOpen = !validationOpen"
          >
            <UIcon
              :name="validationReport.passed ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'"
              class="h-3.5 w-3.5 shrink-0"
              :class="validationReport.passed ? 'text-emerald-400' : 'text-rose-400'"
            />
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('panels.stepDetail.validation.heading') }}
            </span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
              :class="
                validationReport.passed
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-rose-500/15 text-rose-300'
              "
            >
              {{
                validationReport.passed
                  ? t('panels.stepDetail.validation.passed')
                  : t('panels.stepDetail.validation.failed')
              }}
            </span>
            <span class="min-w-0 flex-1 truncate text-[12px] text-slate-400">
              {{
                t('panels.stepDetail.validation.attempts', {
                  attempts: validationReport.attempts,
                  maxAttempts: validationReport.maxAttempts,
                })
              }}
            </span>
            <UIcon
              :name="validationOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
              class="ms-auto h-3.5 w-3.5 shrink-0 text-slate-500"
            />
          </button>
          <div v-if="validationOpen" class="max-h-72 overflow-y-auto px-5 pb-3">
            <StepValidationReport :report="validationReport" />
          </div>
        </section>

        <!-- Shared trailing section: the bugfix reproduction proof (the declared check run against
             the pre-fix tree and the final one). Collapsed when it proved the fix, expanded when it
             did not — an inconclusive verdict or an infeasibility declaration is the one a reviewer
             opened the window to read. -->
        <section
          v-if="reproductionReport"
          class="shrink-0 border-t border-slate-800 bg-slate-900/60"
          data-testid="result-window-reproduction"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-5 py-2 text-start hover:bg-slate-800/40"
            :aria-expanded="reproductionOpen"
            data-testid="result-window-reproduction-toggle"
            @click="reproductionOpen = !reproductionOpen"
          >
            <UIcon
              :name="reproductionKeys!.icon"
              class="h-3.5 w-3.5 shrink-0"
              :class="reproductionKeys!.proven ? 'text-emerald-400' : 'text-amber-400'"
            />
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('panels.stepDetail.reproduction.heading') }}
            </span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium"
              :class="
                reproductionKeys!.proven
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-amber-500/15 text-amber-300'
              "
            >
              {{ t(reproductionKeys!.chip) }}
            </span>
            <span class="min-w-0 flex-1 truncate text-[12px] text-slate-400">
              {{ t(reproductionKeys!.verdict) }}
            </span>
            <UIcon
              :name="reproductionOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
              class="ms-auto h-3.5 w-3.5 shrink-0 text-slate-500"
            />
          </button>
          <div v-if="reproductionOpen" class="max-h-72 overflow-y-auto px-5 pb-3">
            <StepReproductionReport :report="reproductionReport" />
          </div>
        </section>

        <!-- Shared trailing section: what this step's agent declared it stored through a
             foundational storage service (see `binaryOutputs` above for why it lives here and
             not in a window). The collapsed row states the OUTCOME, never a count — five of
             the six outcomes have no artifacts to count, and "0" is the one thing they must
             not all read as. -->
        <section
          v-if="binaryOutputs"
          class="shrink-0 border-t border-slate-800 bg-slate-900/60"
          data-testid="result-window-binary-outputs"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-5 py-2 text-start hover:bg-slate-800/40"
            :aria-expanded="binaryOutputsOpen"
            data-testid="result-window-binary-outputs-toggle"
            @click="binaryOutputsOpen = !binaryOutputsOpen"
          >
            <UIcon name="i-lucide-image" class="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('binaryOutput.heading') }}
            </span>
            <span class="min-w-0 flex-1 truncate text-[12px] text-slate-400">
              {{ binaryOutputSummary }}
            </span>
            <UIcon
              :name="binaryOutputsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
              class="ms-auto h-3.5 w-3.5 shrink-0 text-slate-500"
            />
          </button>
          <div v-if="binaryOutputsOpen && activeStep" class="max-h-72 overflow-y-auto px-5 pb-3">
            <BinaryOutputReport :step="activeStep" />
          </div>
        </section>
      </div>
    </div>
  </Teleport>
</template>
