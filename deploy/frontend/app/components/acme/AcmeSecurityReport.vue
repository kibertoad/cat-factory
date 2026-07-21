<script setup lang="ts">
// A WORKED EXAMPLE of a CONSUMER-shipped result window — the frontend analogue of the
// backend `@cat-factory/example-custom-agent` package. It provides a bespoke run-detail
// window for the `security-auditor` agent kind (see the module registration in
// `~/modular/acme-security.ts`), paired against the namespaced `acme:security-report`
// resultView id.
//
// The point of this file is DOGFOODING the layer's public building blocks: a consumer
// deployment gets the SAME shared chrome + run-metadata surface the first-party windows
// use, with ZERO host edits — the shared components below are referenced through the
// `#components` virtual module (Nuxt's stable registry of the layer's auto-imported
// components), NOT deep file paths into the layer's `app/components/*` internals:
//   - `<ResultWindowShell>`   — the shared modal chrome (backdrop, header, focus-trap,
//                               scroll-lock, shared-stack Escape via `useModalBehavior`)
//                               + the "restart from here" control when given a `stepRef`.
//   - `<StepRunMeta>`         — the shared run-details metadata block every agent window
//                               reuses (step position, live duration, model, run id, the
//                               LLM model-activity rollup). A consumer NEVER reinvents it.
//   - `useResultView(id)`     — the seam contract (open / blockId / instanceId / stepIndex
//                               / close), auto-imported like the rest of the layer's
//                               composables. The host (`StepResultViewHost`) mounts this
//                               window when a `security-auditor` step is opened.
//   - `<MarkdownProse>`       — the shared prose renderer.
//
// Why `#components` rather than bare `<ResultWindowShell>` tags: Nuxt auto-registers a
// layer's components under a path-derived name (`PanelsResultWindowShell`), so a bare tag
// in a CONSUMER SFC resolves to nothing and silently renders as an unknown element. The
// layer's own SFCs are transformed in-scope so their bare tags resolve; a consumer SFC is
// not, so it names the components explicitly via `#components` (aliased back to the short
// names for readability). Slice G hardens this into an explicitly exported public surface.
//
// It reads the auditor's structured assessment straight off the execution step
// (`step.custom`, the engine's structured-output channel), rendering it as a real report;
// when a run produced only prose (e.g. an inline variant) it falls back to that. All copy
// is translated through the deployment's own i18n catalog (`acme.*` in
// `deploy/frontend/i18n/locales/en.json`, deep-merged into the layer catalog).
import { computed } from 'vue'
import {
  PanelsResultWindowShell as ResultWindowShell,
  PanelsStepRunMeta as StepRunMeta,
  CommonMarkdownProse as MarkdownProse,
} from '#components'

/** The structured assessment the backend `security-auditor` kind returns as `result.custom`
 *  (mirrors `@cat-factory/example-custom-agent`'s `securityAssessment`). Read defensively —
 *  it arrives untyped over the wire, and a run may have produced none. */
interface SecurityFinding {
  title?: string
  detail?: string
  severity?: 'low' | 'medium' | 'high' | 'critical'
}
interface SecurityAssessment {
  risk?: number
  summary?: string
  findings?: SecurityFinding[]
}

const board = useBoardStore()
const execution = useExecutionStore()
const agents = useAgentsStore()
const { t, n } = useI18n()

// The shared seam contract. No `onOpen` loader: this window reads its data straight off the
// execution step, so there is nothing to fetch on open. `ResultWindowShell` owns Escape.
const { open, blockId, instanceId, stepIndex, close } = useResultView('acme:security-report')

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
// Resolve the kind's presentation from the merged agent catalog (built-ins + this
// deployment's consumer/backend kinds) so the header icon/label match the palette entry.
const meta = computed(() => (step.value ? agents.get(step.value.agentKind) : undefined))

const assessment = computed<SecurityAssessment | null>(() => {
  const custom = step.value?.custom
  return custom && typeof custom === 'object' ? (custom as SecurityAssessment) : null
})
const findings = computed<SecurityFinding[]>(() => assessment.value?.findings ?? [])
/** Risk as a 0..100 percentage string via the shared i18n number formatting. */
const riskLabel = computed(() => {
  const risk = assessment.value?.risk
  return typeof risk === 'number' ? n(risk, 'percent') : null
})

const SEVERITY_CLASS: Record<NonNullable<SecurityFinding['severity']>, string> = {
  low: 'bg-slate-500/15 text-slate-300',
  medium: 'bg-amber-500/15 text-amber-300',
  high: 'bg-orange-500/15 text-orange-300',
  critical: 'bg-rose-500/15 text-rose-300',
}

const headerTitle = computed(() =>
  block.value
    ? t('acme.securityReport.titleWithBlock', { title: block.value.title })
    : t('acme.securityReport.title'),
)
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-shield-check"
    icon-class="bg-rose-500/15 text-rose-300"
    :title="headerTitle"
    :subtitle="meta?.description ?? t('acme.securityReport.subtitle')"
    :step-ref="{ instanceId, stepIndex }"
    width="4xl"
    testid="acme-security-report-window"
    @close="close"
  >
    <template #header-extras>
      <span
        v-if="riskLabel"
        class="rounded-md bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-300"
        data-testid="acme-security-risk"
      >
        {{ t('acme.securityReport.riskBadge', { risk: riskLabel }) }}
      </span>
    </template>

    <div class="flex min-h-0 flex-1">
      <!-- Main: the auditor's assessment (structured), or its prose fall-back. -->
      <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4" data-testid="acme-security-body">
        <MarkdownProse
          v-if="assessment?.summary"
          :text="assessment.summary"
          class="mb-4 text-[13px] leading-relaxed text-slate-300"
        />
        <MarkdownProse
          v-else-if="step?.output"
          :text="step.output"
          class="mb-4 text-[13px] leading-relaxed text-slate-300"
        />

        <template v-if="findings.length">
          <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('acme.securityReport.findingsHeading') }}
          </h3>
          <ul class="flex flex-col gap-2">
            <li
              v-for="(finding, i) in findings"
              :key="i"
              class="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
              data-testid="acme-security-finding"
            >
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-medium text-slate-200">
                  {{ finding.title ?? t('acme.securityReport.untitledFinding') }}
                </span>
                <span
                  v-if="finding.severity"
                  class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                  :class="SEVERITY_CLASS[finding.severity]"
                >
                  {{ t(`acme.securityReport.severity.${finding.severity}`) }}
                </span>
              </div>
              <p v-if="finding.detail" class="mt-1 text-[12px] leading-relaxed text-slate-400">
                {{ finding.detail }}
              </p>
            </li>
          </ul>
        </template>

        <div
          v-else-if="!assessment?.summary && !step?.output"
          class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
        >
          <UIcon name="i-lucide-shield-check" class="h-8 w-8 opacity-40" />
          <p class="text-sm">{{ t('acme.securityReport.empty') }}</p>
        </div>
      </div>

      <!-- Sidebar: the SHARED run-metadata block — reused verbatim, never reinvented. -->
      <aside
        class="hidden w-60 shrink-0 flex-col gap-4 border-s border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
      >
        <StepRunMeta
          v-if="step"
          :step="step"
          :instance-id="instanceId ?? undefined"
          :step-number="stepIndex === null ? undefined : stepIndex + 1"
          :total-steps="instance?.steps.length"
          :run-failed="instance?.status === 'failed'"
          :failure-at="instance?.failure?.occurredAt"
        />
      </aside>
    </div>
  </ResultWindowShell>
</template>
