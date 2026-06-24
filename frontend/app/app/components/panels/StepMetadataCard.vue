<script setup lang="ts">
import { computed } from 'vue'
import type { AgentState, PipelineStep, CompanionVerdict } from '~/types/execution'
import { subtaskIconClass } from '~/utils/pipelineRender'
import StepMetricsBar from '~/components/observability/StepMetricsBar.vue'

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

const ui = useUiStore()
const models = useModelsStore()

const STATE_META: Record<AgentState, { label: string; color: string }> = {
  pending: { label: 'Pending', color: '#64748b' },
  working: { label: 'Working', color: '#6366f1' },
  waiting_decision: { label: 'Needs input', color: '#f59e0b' },
  done: { label: 'Done', color: '#22c55e' },
}

// The state badge: a step left mid-flight on a failed run keeps `state: 'working'`,
// so report it as "Failed" rather than the misleading "Working".
const stateMeta = computed(() => {
  const s = props.step
  if (props.runFailed && s.state === 'working') return { label: 'Failed', color: '#ef4444' }
  return STATE_META[s.state]
})

const modelLabel = computed(() => (props.step.model ? models.labelForRef(props.step.model) : null))

const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}

const pctOf = (n: number) => `${Math.round(n * 100)}%`

function formatClock(ms?: number | null): string | null {
  return ms ? new Date(ms).toLocaleString() : null
}

async function copyRunId() {
  const id = props.step.runId ?? props.instanceId
  if (id) await navigator.clipboard?.writeText(id)
}

function openObservability() {
  if (props.instanceId) ui.openObservability(props.instanceId)
}
</script>

<template>
  <div>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">State</dt>
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
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">Duration</dt>
        <dd class="mt-0.5 flex items-center gap-1.5 tabular-nums text-slate-200">
          <UIcon
            v-if="isRunning"
            name="i-lucide-loader-circle"
            class="h-3 w-3 animate-spin text-indigo-400"
          />
          <span v-if="durationLabel">{{ durationLabel }}</span>
          <span v-else class="text-slate-500">—</span>
          <span v-if="isRunning" class="text-[11px] text-slate-500">elapsed</span>
        </dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">Step</dt>
        <dd class="mt-0.5 text-slate-200">{{ stepNumber }} of {{ totalSteps }}</dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">Started</dt>
        <dd class="mt-0.5 text-slate-300">{{ formatClock(step.startedAt) ?? '—' }}</dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">Finished</dt>
        <dd class="mt-0.5 text-slate-300">{{ formatClock(step.finishedAt) ?? '—' }}</dd>
      </div>
      <div>
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">Model</dt>
        <dd class="mt-0.5 truncate text-slate-300" :title="step.model">
          {{ modelLabel ?? 'Not recorded' }}
        </dd>
      </div>
      <!-- The run id this step belongs to, surfaced for debugging (copyable). -->
      <div class="col-span-2 sm:col-span-3">
        <dt class="text-[11px] uppercase tracking-wide text-slate-500">Run</dt>
        <dd
          class="mt-0.5 cursor-pointer truncate font-mono text-[12px] text-slate-400 hover:text-slate-200"
          :title="`${step.runId ?? instanceId ?? ''} — click to copy`"
          @click="copyRunId"
        >
          {{ step.runId ?? instanceId ?? '—' }}
        </dd>
      </div>
    </dl>

    <!-- container cold-boot phase: shown until the container is up and
         the agent starts reporting progress -->
    <div
      v-if="step.startingContainer && !runFailed"
      class="mt-4 flex items-center gap-2 rounded-lg border border-sky-900/50 bg-sky-950/30 px-3 py-2 text-[12px] text-sky-300"
    >
      <UIcon name="i-lucide-loader-circle" class="h-4 w-4 shrink-0 animate-spin" />
      <span>Spinning up container…</span>
    </div>

    <!-- live subtask breakdown -->
    <div v-if="step.subtasks && step.subtasks.total > 0" class="mt-4">
      <div class="text-[11px] uppercase tracking-wide text-slate-500">
        Subtasks · {{ step.subtasks.completed }}/{{ step.subtasks.total }}
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
         transport-vs-execution); click to open the full per-call panel -->
    <div v-if="step.metrics && step.metrics.calls > 0" class="mt-4">
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] uppercase tracking-wide text-slate-500"> Model activity </span>
        <button class="text-[11px] text-sky-400 hover:text-sky-300" @click="openObservability">
          View all calls →
        </button>
      </div>
      <StepMetricsBar :metrics="step.metrics" clickable @inspect="openObservability" />
    </div>

    <!-- standards (prompt fragments) folded into this step -->
    <div v-if="step.selectedFragmentIds && step.selectedFragmentIds.length" class="mt-4">
      <div class="text-[11px] uppercase tracking-wide text-slate-500">Standards applied</div>
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
      <div class="text-[11px] uppercase tracking-wide text-slate-500">Decision</div>
      <p class="mt-0.5 text-[13px] text-slate-200">{{ step.decision.question }}</p>
      <p
        v-if="step.decision.chosen"
        class="mt-0.5 flex items-center gap-1 text-[12px] text-emerald-400"
      >
        <UIcon name="i-lucide-check" class="h-3 w-3 shrink-0" />
        {{ step.decision.chosen }}
      </p>
      <p v-else class="mt-0.5 text-[12px] text-amber-400">Awaiting a human choice</p>
    </div>

    <!-- approval gate state -->
    <div v-if="step.approval" class="mt-4">
      <div class="text-[11px] uppercase tracking-wide text-slate-500">Approval gate</div>
      <p class="mt-0.5 text-[13px] text-slate-200 capitalize">
        {{ step.approval.status.replace('_', ' ') }}
      </p>
    </div>

    <!-- companion verdict + full correction sequence -->
    <div v-if="companionVerdicts.length" class="mt-4">
      <div class="flex items-center justify-between">
        <span class="text-[11px] uppercase tracking-wide text-slate-500"> Companion review </span>
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
            <span v-if="v.feedback" class="ml-1 text-slate-400">— {{ v.feedback }}</span>
          </div>
        </li>
      </ol>
      <p v-if="companionVerdicts.length > 1" class="mt-1 text-[11px] text-slate-500">
        {{ companionVerdicts.length }} correction iteration(s).
      </p>
    </div>
  </div>
</template>
