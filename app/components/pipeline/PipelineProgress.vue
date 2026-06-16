<script setup lang="ts">
import type { AgentState, ExecutionInstance } from '~/types/domain'
import { AGENT_BY_KIND } from '~/utils/catalog'

const props = defineProps<{ instance: ExecutionInstance }>()
const emit = defineEmits<{ openDecision: [decisionId: string] }>()

const models = useModelsStore()

/** Visual language for an individual agent's runtime state. */
const STATE_META: Record<AgentState, { label: string; color: string; icon: string }> = {
  pending: { label: 'Pending', color: '#64748b', icon: 'i-lucide-circle-dashed' },
  working: { label: 'Working', color: '#6366f1', icon: 'i-lucide-loader' },
  waiting_decision: { label: 'Needs decision', color: '#f59e0b', icon: 'i-lucide-circle-help' },
  done: { label: 'Done', color: '#22c55e', icon: 'i-lucide-circle-check' },
}

/** Visual language for the pipeline instance as a whole. */
const STATUS_META: Record<ExecutionInstance['status'], { label: string; chip: string }> = {
  running: { label: 'Running', chip: 'primary' },
  blocked: { label: 'Blocked on decision', chip: 'warning' },
  paused: { label: 'Paused (budget)', chip: 'neutral' },
  done: { label: 'Completed', chip: 'success' },
}

const steps = computed(() => props.instance.steps)
const total = computed(() => steps.value.length)

/** A step counts as fully complete only once its state is `done`. */
const completedCount = computed(() => steps.value.filter((s) => s.state === 'done').length)

/** Effective 0..1 progress per step (a done step is always 100%). */
function stepProgress(state: AgentState, progress: number) {
  return state === 'done' ? 1 : progress
}

/** Overall pipeline progress: the mean of every step's effective progress. */
const overallProgress = computed(() => {
  if (!total.value) return 0
  const sum = steps.value.reduce((acc, s) => acc + stepProgress(s.state, s.progress), 0)
  return sum / total.value
})
const overallPct = computed(() => Math.round(overallProgress.value * 100))

const statusMeta = computed(() => STATUS_META[props.instance.status])

/** The agent the pipeline is currently centred on (for the summary line). */
const currentAgent = computed(() => {
  const s = steps.value[props.instance.currentStep]
  return s ? AGENT_BY_KIND[s.agentKind].label : null
})

/** Connector below a step is "lit" once that step has completed. */
function connectorDone(index: number) {
  return steps.value[index]?.state === 'done'
}

const legend: { state: AgentState }[] = [
  { state: 'done' },
  { state: 'working' },
  { state: 'waiting_decision' },
  { state: 'pending' },
]
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- summary -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <UBadge :color="statusMeta.chip as any" variant="subtle">{{ statusMeta.label }}</UBadge>
        <span class="text-sm text-slate-300">
          <span class="font-semibold text-white">{{ completedCount }}</span>
          / {{ total }} agents complete
        </span>
        <span v-if="currentAgent && instance.status === 'running'" class="text-xs text-slate-500">
          · currently {{ currentAgent }}
        </span>
        <span class="ml-auto font-mono text-sm tabular-nums text-slate-200">{{ overallPct }}%</span>
      </div>
      <UProgress :model-value="overallPct" class="mt-3" />

      <!-- legend -->
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span
          v-for="l in legend"
          :key="l.state"
          class="inline-flex items-center gap-1.5 text-[11px] text-slate-400"
        >
          <span
            class="h-2 w-2 rounded-full"
            :style="{ backgroundColor: STATE_META[l.state].color }"
          />
          {{ STATE_META[l.state].label }}
        </span>
      </div>
    </div>

    <!-- agent chain as a vertical timeline -->
    <ol class="flex flex-col">
      <li v-for="(s, i) in steps" :key="i" class="relative flex gap-4 pb-5 last:pb-0">
        <!-- connector line to the next step -->
        <span
          v-if="i < steps.length - 1"
          class="absolute top-9 bottom-0 left-[17px] w-0.5 -translate-x-1/2"
          :class="connectorDone(i) ? 'bg-emerald-500/60' : 'bg-slate-700'"
        />

        <!-- rail node -->
        <span
          class="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 bg-slate-950"
          :class="s.state === 'working' ? 'step-active' : ''"
          :style="{ borderColor: STATE_META[s.state].color }"
        >
          <UIcon
            :name="STATE_META[s.state].icon"
            class="h-4 w-4"
            :class="s.state === 'working' ? 'animate-spin' : ''"
            :style="{ color: STATE_META[s.state].color }"
          />
        </span>

        <!-- step content card -->
        <div
          class="flex-1 rounded-xl border p-4 transition"
          :class="[
            i === instance.currentStep && instance.status !== 'done'
              ? 'border-indigo-500/70 bg-slate-900 shadow-lg shadow-indigo-500/10'
              : 'border-slate-800 bg-slate-900/50',
            s.state === 'pending' ? 'opacity-60' : '',
          ]"
        >
          <div class="flex items-center gap-2">
            <div
              class="flex h-8 w-8 items-center justify-center rounded-lg"
              :style="{ backgroundColor: AGENT_BY_KIND[s.agentKind].color + '22' }"
            >
              <UIcon
                :name="AGENT_BY_KIND[s.agentKind].icon"
                class="h-4 w-4"
                :style="{ color: AGENT_BY_KIND[s.agentKind].color }"
              />
            </div>
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold text-white">
                {{ AGENT_BY_KIND[s.agentKind].label }}
              </div>
              <div class="text-[10px] uppercase tracking-wide text-slate-500">
                Step {{ i + 1 }} of {{ total }}
              </div>
            </div>
            <span
              class="ml-auto shrink-0 text-[11px] font-medium"
              :style="{ color: STATE_META[s.state].color }"
            >
              {{ STATE_META[s.state].label }}
            </span>
          </div>

          <!-- per-step progress (only while it has meaningful progress) -->
          <UProgress
            v-if="s.state === 'working' || s.state === 'done'"
            :model-value="Math.round(stepProgress(s.state, s.progress) * 100)"
            size="xs"
            class="mt-3"
          />

          <!-- live subtask counts from the agent's todo list -->
          <div v-if="s.subtasks && s.subtasks.total > 0" class="mt-2">
            <div class="flex items-center justify-between text-[10px] text-slate-400">
              <span>
                {{ s.subtasks.completed }}/{{ s.subtasks.total }} subtasks
                <span v-if="s.subtasks.inProgress > 0" class="text-indigo-300">
                  · {{ s.subtasks.inProgress }} in progress
                </span>
              </span>
            </div>
            <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-700/60">
              <div
                class="h-full rounded-full bg-indigo-400 transition-all duration-500"
                :style="{ width: `${(s.subtasks.completed / s.subtasks.total) * 100}%` }"
              />
            </div>
          </div>

          <!-- model used for this step -->
          <p
            v-if="s.model"
            class="mt-2 flex items-center gap-1 truncate text-[10px] text-slate-500"
            :title="s.model"
          >
            <UIcon name="i-lucide-cpu" class="h-3 w-3 shrink-0" />
            {{ models.labelForRef(s.model) }}
          </p>

          <!-- output the agent produced -->
          <p
            v-if="s.output"
            class="mt-2 line-clamp-3 rounded-md bg-slate-950/60 px-2 py-1.5 text-[11px] text-slate-300"
            :title="s.output"
          >
            {{ s.output }}
          </p>

          <!-- decision: unresolved => prompt, resolved => show the choice -->
          <div v-if="s.decision && !s.decision.chosen" class="mt-3">
            <UButton
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-circle-help"
              @click="emit('openDecision', s.decision.id)"
            >
              Resolve: {{ s.decision.question }}
            </UButton>
          </div>
          <p
            v-else-if="s.decision?.chosen"
            class="mt-2 flex items-center gap-1 truncate text-[11px] text-emerald-400"
            :title="s.decision.chosen"
          >
            <UIcon name="i-lucide-check" class="h-3 w-3 shrink-0" />
            {{ s.decision.chosen }}
          </p>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
/* Soft indigo halo around the rail node of the actively-working step. */
@keyframes step-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(99, 102, 241, 0);
  }
}
.step-active {
  animation: step-pulse 1.6s ease-in-out infinite;
}
</style>
