<script setup lang="ts">
import { computed } from 'vue'
import {
  bySeverityWorstFirst,
  isReviewCommentSeverity,
  type ReviewCommentSeverity,
} from '@cat-factory/contracts'
import type { AgentState, PipelineStep, CompanionVerdict, StepApproval } from '~/types/execution'
import type { BadgeColor } from '~/utils/badge'
import { subtaskIconClass } from '~/utils/pipelineRender'
import StepModelActivity from '~/components/observability/StepModelActivity.vue'
import StepContainerStatus from '~/components/panels/StepContainerStatus.vue'
import CopyButton from '~/components/common/CopyButton.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'

// The step's metadata card body: state/timing/model/run id, the container cold-boot
// phase, the live subtask breakdown, the LLM observability rollup, the applied
// standards, any raised decision/approval gate, and the companion verdict sequence.
// The scroll-spy `#step-details` section wrapper + ref stay in the parent reader.
const props = defineProps<{
  step: PipelineStep
  runFailed: boolean
  /** Whether the run is still being driven; passed through so its container card can freeze. */
  runActive: boolean
  durationLabel: string | null
  isRunning: boolean
  stepNumber: number
  totalSteps: number
  instanceId?: string
  companionVerdicts: CompanionVerdict[]
  latestVerdict: CompanionVerdict | null
}>()

const models = useModelsStore()
const { t, d } = useI18n()

const STATE_LABEL_KEYS: Record<AgentState, string> = {
  pending: 'panels.stepMeta.state.pending',
  working: 'panels.stepMeta.state.working',
  waiting_decision: 'panels.stepMeta.state.waiting_decision',
  done: 'panels.stepMeta.state.done',
}
const STATE_COLOR: Record<AgentState, string> = {
  pending: '#64748b',
  working: '#6366f1',
  waiting_decision: '#f59e0b',
  done: '#22c55e',
}

// The state badge: a step left mid-flight on a failed run keeps `state: 'working'`,
// so report it as "Failed" rather than the misleading "Working".
const stateMeta = computed(() => {
  const s = props.step
  if (props.runFailed && s.state === 'working')
    return { label: t('panels.stepMeta.state.failed'), color: '#ef4444' }
  return { label: t(STATE_LABEL_KEYS[s.state]), color: STATE_COLOR[s.state] }
})

const modelLabel = computed(() => (props.step.model ? models.labelForRef(props.step.model) : null))

/**
 * The deployment-registered VARIANT this step ran under — an alternate prompt for its agent kind.
 * Reported beside the model because it is the other half of "what actually ran"; null on every
 * step that ran the shipped prompt, so the field is simply absent on the stock product.
 */
const promptVariant = useStepPromptVariant(() => props.step)

const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}

const pctOf = (n: number) => `${Math.round(n * 100)}%`

/**
 * The colour each finding grade renders at. `ungraded` is its own member rather than a fallback
 * arm: a person's comment carries no severity and neither does a verdict recorded before reviewers
 * graded anything, and painting either of those `major` would put a level on the screen that
 * nobody chose. `unrecognized` is the same argument for the other direction (see
 * {@link findingGrade}). An exhaustive `Record` so a severity added to the contract fails to
 * compile here, typed against the shared `BadgeColor` rather than a hand-picked subset of it.
 */
const SEVERITY_COLOR: Record<ReviewCommentSeverity | 'ungraded' | 'unrecognized', BadgeColor> = {
  blocker: 'error',
  major: 'warning',
  minor: 'neutral',
  ungraded: 'neutral',
  unrecognized: 'neutral',
}

/**
 * How one finding's grade renders: the level itself, or which of the two NON-levels it is.
 *
 * `unrecognized` is what a level this build has retired reads as. The severity vocabulary is closed
 * but persisted, and a stored verdict is mapped onto the type rather than re-parsed, so the schema's
 * `major` fallback never runs on this path (contracts' `isReviewCommentSeverity` states the rule).
 * Left unnarrowed the value indexes both maps and comes back `undefined`, which renders an unstyled
 * badge over a raw i18n key; guessed onto a current level it would show an urgency nobody graded, on
 * the panel asking a person to act on it. So it is NAMED, and the copy carries the stored value.
 */
function findingGrade(severity: string | undefined): {
  key: ReviewCommentSeverity | 'ungraded' | 'unrecognized'
  level: string
} {
  if (severity === undefined) return { key: 'ungraded', level: '' }
  if (isReviewCommentSeverity(severity)) return { key: severity, level: severity }
  return { key: 'unrecognized', level: severity }
}

/**
 * Each round paired with its findings, worst first (the order the reviewer's asks should be worked
 * in) and each finding with its resolved grade.
 *
 * A `computed` rather than methods the template calls, because a run panel re-renders on every
 * pushed instance update while the template needs the list twice per round (the `v-if` and the
 * `v-for`) and the grade three times per finding: as methods that is a copy, a sort and a narrowing
 * per reader per push, all off state that only changes when a verdict lands.
 */
const verdictRounds = computed(() =>
  props.companionVerdicts.map((verdict) => ({
    verdict,
    findings: bySeverityWorstFirst(verdict.comments ?? []).map((finding) => ({
      body: finding.body,
      grade: findingGrade(finding.severity),
    })),
  })),
)

/**
 * Whether this round's rating actually reached its bar.
 *
 * Distinct from the verdict's own `passed`, which is what the ENGINE decided and can be `false` at a
 * rating well above the threshold: an open `blocker` holds the step whatever the number says. The
 * two were one expression, so the panel printed a false inequality over the findings that explained
 * it. `>=` matches kernel's `disposeCompanionVerdict`, where a threshold typed by an operator must be
 * met exactly by a rating equal to it.
 */
const ratingMeetsBar = (verdict: CompanionVerdict) => verdict.rating >= verdict.threshold

const APPROVAL_STATUS_KEYS: Record<StepApproval['status'], string> = {
  pending: 'panels.stepMeta.approvalStatus.pending',
  approved: 'panels.stepMeta.approvalStatus.approved',
  changes_requested: 'panels.stepMeta.approvalStatus.changes_requested',
  rejected: 'panels.stepMeta.approvalStatus.rejected',
}
const approvalStatusLabel = computed(() =>
  props.step.approval ? t(APPROVAL_STATUS_KEYS[props.step.approval.status]) : '',
)

function formatClock(ms?: number | null): string | null {
  return ms ? d(new Date(ms), 'long') : null
}

const { copy } = useCopyToClipboard()
async function copyRunId() {
  const id = props.step.runId ?? props.instanceId
  if (id) await copy(id)
}
</script>

<template>
  <div>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.stateLabel') }}
        </dt>
        <dd class="mt-0.5 flex items-center gap-1.5 text-slate-200">
          <UIcon
            v-if="runFailed && step.state === 'working'"
            name="i-lucide-circle-x"
            class="h-3.5 w-3.5 shrink-0"
            :style="{ color: stateMeta.color }"
          />
          <span v-else class="h-2 w-2 rounded-full" :style="{ backgroundColor: stateMeta.color }" />
          {{ stateMeta.label }}
        </dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.duration') }}
        </dt>
        <dd class="mt-0.5 flex items-center gap-1.5 tabular-nums text-slate-200">
          <UIcon
            v-if="isRunning"
            name="i-lucide-loader-circle"
            class="h-3 w-3 animate-spin text-indigo-400"
          />
          <span v-if="durationLabel">{{ durationLabel }}</span>
          <span v-else class="text-slate-500">—</span>
          <span v-if="isRunning" class="text-[11px] text-slate-500">{{
            t('panels.stepMeta.elapsed')
          }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.step') }}
        </dt>
        <dd class="mt-0.5 text-slate-200">
          {{ t('panels.stepMeta.stepOf', { number: stepNumber, total: totalSteps }) }}
        </dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.started') }}
        </dt>
        <dd class="mt-0.5 text-slate-300">{{ formatClock(step.startedAt) ?? '—' }}</dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.finished') }}
        </dt>
        <dd class="mt-0.5 text-slate-300">{{ formatClock(step.finishedAt) ?? '—' }}</dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.model') }}
        </dt>
        <dd class="mt-0.5 truncate text-slate-300" :title="step.model">
          {{ modelLabel ?? t('panels.stepMeta.notRecorded') }}
        </dd>
      </div>
      <div v-if="promptVariant">
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.promptVariant') }}
        </dt>
        <dd class="mt-0.5 truncate text-slate-300">{{ promptVariant.label }}</dd>
        <dd v-if="promptVariant.note" class="mt-0.5 text-[11px] text-amber-400/80">
          {{ promptVariant.note }}
        </dd>
      </div>
      <!-- The run id this step belongs to, surfaced for debugging (copyable). -->
      <div class="col-span-2 sm:col-span-3">
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.run') }}
        </dt>
        <dd
          class="mt-0.5 cursor-pointer truncate font-mono text-[12px] text-slate-400 hover:text-slate-200"
          :title="t('panels.stepMeta.clickToCopy', { id: step.runId ?? instanceId ?? '' })"
          @click="copyRunId"
        >
          {{ step.runId ?? instanceId ?? '—' }}
        </dd>
      </div>
    </dl>

    <!-- container lifecycle (status / live phase / id + url) — shared with the Tester
         window so both surface what the container is doing and where it lives. -->
    <StepContainerStatus
      :step="step"
      :run-failed="runFailed"
      :run-active="runActive"
      class="mt-4"
    />

    <!-- live subtask breakdown -->
    <div v-if="step.subtasks && step.subtasks.total > 0" class="mt-4">
      <div class="text-[11px] uppercase tracking-wide text-slate-500">
        {{
          t('panels.stepMeta.subtasks', {
            completed: step.subtasks.completed,
            total: step.subtasks.total,
          })
        }}
      </div>
      <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-700/60">
        <div
          class="h-full rounded-full bg-indigo-400 transition-all duration-500"
          :style="{
            width: `${(step.subtasks.completed / step.subtasks.total) * 100}%`,
          }"
        />
      </div>
      <ul v-if="step.subtasks.items?.length" class="mt-2 space-y-1">
        <li
          v-for="(item, idx) in step.subtasks.items"
          :key="idx"
          class="flex items-start gap-1.5 text-[12px]"
          :class="
            item.status === 'completed'
              ? 'text-slate-500 line-through'
              : item.status === 'in_progress'
                ? 'text-slate-100'
                : 'text-slate-400'
          "
        >
          <UIcon
            :name="ITEM_ICON[item.status]"
            class="mt-px h-3 w-3 shrink-0"
            :class="subtaskIconClass(item.status, runFailed)"
          />
          <span>{{ item.label }}</span>
        </li>
      </ul>
    </div>

    <!-- LLM observability rollup (tokens, output-limit headroom,
         transport-vs-execution); click to open the full per-call panel. Self-gates: the
         "View all calls →" link shows for any run, the metrics bar only when calls exist. -->
    <StepModelActivity class="mt-4" :metrics="step.metrics" :instance-id="instanceId" />

    <!-- standards (prompt fragments) folded into this step -->
    <div v-if="step.selectedFragmentIds && step.selectedFragmentIds.length" class="mt-4">
      <div
        class="text-[11px] uppercase tracking-wide text-slate-500"
        :title="t('panels.stepMeta.standardsAppliedHint')"
      >
        {{ t('panels.stepMeta.standardsApplied') }}
      </div>
      <div class="mt-1 flex flex-wrap gap-1">
        <UBadge
          v-for="id in step.selectedFragmentIds"
          :key="id"
          color="neutral"
          variant="subtle"
          size="sm"
        >
          {{ id }}
        </UBadge>
      </div>
    </div>

    <!-- decision raised on this step -->
    <div v-if="step.decision" class="mt-4">
      <div class="text-[11px] uppercase tracking-wide text-slate-500">
        {{ t('panels.stepMeta.decision') }}
      </div>
      <p class="mt-0.5 text-[13px] text-slate-200">{{ step.decision.question }}</p>
      <p
        v-if="step.decision.chosen"
        class="mt-0.5 flex items-center gap-1 text-[12px] text-emerald-400"
      >
        <UIcon name="i-lucide-check" class="h-3 w-3 shrink-0" />
        {{ step.decision.chosen }}
      </p>
      <p v-else class="mt-0.5 text-[12px] text-amber-400">
        {{ t('panels.stepMeta.awaitingChoice') }}
      </p>
    </div>

    <!-- approval gate state -->
    <div v-if="step.approval" class="mt-4">
      <div class="text-[11px] uppercase tracking-wide text-slate-500">
        {{ t('panels.stepMeta.approvalGate') }}
      </div>
      <p class="mt-0.5 text-[13px] text-slate-200">
        {{ approvalStatusLabel }}
      </p>
    </div>

    <!-- companion verdict + full correction sequence -->
    <div v-if="companionVerdicts.length" class="mt-4">
      <div class="flex items-center justify-between">
        <span class="text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.companionReview') }}
        </span>
        <!-- The COLOUR is the verdict (`passed`) and the GLYPH is the arithmetic, which are no
             longer the same fact: a round holding an open `blocker` fails at a rating that cleared
             its bar, and reading the inequality off `passed` printed "95% < 80%" over the findings
             explaining why. -->
        <UBadge :color="latestVerdict?.passed ? 'success' : 'warning'" variant="subtle" size="sm">
          {{ pctOf(latestVerdict!.rating) }}
          {{ ratingMeetsBar(latestVerdict!) ? '≥' : '<' }} {{ pctOf(latestVerdict!.threshold) }}
        </UBadge>
      </div>
      <!-- One card per correction round: the score on its own line, then the reviewer's verdict
           as rendered markdown, then its graded findings worst first. The feedback used to trail
           the score inside the same line, which turned a multi-point review into one unreadable
           run of text; the findings used not to be rendered at all, so a "must fix" holding the
           run was invisible to the person being asked to resolve it. -->
      <ol class="mt-2 space-y-2">
        <li
          v-for="({ verdict: v, findings }, i) in verdictRounds"
          :key="i"
          data-testid="companion-verdict"
          class="relative rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2"
        >
          <CopyButton v-if="v.feedback" :text="v.feedback" class="absolute end-1 top-1" />
          <div class="flex items-center gap-2 text-[12px]">
            <span
              class="inline-flex h-4 shrink-0 items-center rounded px-1 font-mono text-[11px] tabular-nums"
              :class="
                v.passed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
              "
            >
              {{ i + 1 }}
            </span>
            <span :class="v.passed ? 'text-emerald-300' : 'text-amber-300'">
              {{ pctOf(v.rating) }} {{ ratingMeetsBar(v) ? '≥' : '<' }} {{ pctOf(v.threshold) }}
            </span>
          </div>
          <MarkdownProse
            v-if="v.feedback"
            :text="v.feedback"
            data-testid="companion-verdict-summary"
            class="mt-1.5 pe-6 text-[12px] leading-relaxed text-slate-300"
          />
          <ul v-if="findings.length" class="mt-2 space-y-1.5">
            <li
              v-for="(finding, fi) in findings"
              :key="fi"
              data-testid="companion-finding"
              class="flex gap-2"
            >
              <UBadge
                :color="SEVERITY_COLOR[finding.grade.key]"
                variant="subtle"
                size="sm"
                class="mt-px h-4 shrink-0"
              >
                {{ t(`panels.stepMeta.findingSeverity.${finding.grade.key}`, finding.grade) }}
              </UBadge>
              <MarkdownProse
                :text="finding.body"
                class="min-w-0 text-[12px] leading-relaxed text-slate-300"
              />
            </li>
          </ul>
        </li>
      </ol>
      <p v-if="companionVerdicts.length > 1" class="mt-1 text-[11px] text-slate-500">
        {{
          t(
            'panels.stepMeta.correctionIterations',
            { count: companionVerdicts.length },
            companionVerdicts.length,
          )
        }}
      </p>
    </div>
  </div>
</template>
