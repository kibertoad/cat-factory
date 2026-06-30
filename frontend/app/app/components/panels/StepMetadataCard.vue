<script setup lang="ts">
import { computed } from 'vue'
import type { AgentState, PipelineStep, CompanionVerdict, StepApproval } from '~/types/execution'
import { subtaskIconClass } from '~/utils/pipelineRender'
import StepModelActivity from '~/components/observability/StepModelActivity.vue'
import StepContainerStatus from '~/components/panels/StepContainerStatus.vue'

// The step's metadata card body: state/timing/model/run id, the container cold-boot
// phase, the live subtask breakdown, the LLM observability rollup, the applied
// standards, any raised decision/approval gate, and the companion verdict sequence.
// The scroll-spy `#step-details` section wrapper + ref stay in the parent reader.
const props = defineProps<{
  step: PipelineStep
  runFailed: boolean
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

const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}

const pctOf = (n: number) => `${Math.round(n * 100)}%`

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

async function copyRunId() {
  const id = props.step.runId ?? props.instanceId
  if (id) await navigator.clipboard?.writeText(id)
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
    <StepContainerStatus :step="step" :run-failed="runFailed" class="mt-4" />

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
      <div class="text-[11px] uppercase tracking-wide text-slate-500">
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
        <UBadge :color="latestVerdict?.passed ? 'success' : 'warning'" variant="subtle" size="sm">
          {{ pctOf(latestVerdict!.rating) }}
          {{ latestVerdict?.passed ? '≥' : '<' }} {{ pctOf(latestVerdict!.threshold) }}
        </UBadge>
      </div>
      <ol class="mt-2 space-y-1.5">
        <li v-for="(v, i) in companionVerdicts" :key="i" class="flex items-start gap-2 text-[12px]">
          <span
            class="mt-px inline-flex h-4 shrink-0 items-center rounded px-1 font-mono text-[11px] tabular-nums"
            :class="
              v.passed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
            "
          >
            {{ i + 1 }}
          </span>
          <div class="min-w-0">
            <span :class="v.passed ? 'text-emerald-300' : 'text-amber-300'">
              {{ pctOf(v.rating) }} {{ v.passed ? '≥' : '<' }} {{ pctOf(v.threshold) }}
            </span>
            <span v-if="v.feedback" class="ms-1 text-slate-400">— {{ v.feedback }}</span>
          </div>
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
