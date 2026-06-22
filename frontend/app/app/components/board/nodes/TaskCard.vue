<script setup lang="ts">
import type { Block } from '~/types/domain'
import { STATUS_META, MODULE_META } from '~/utils/catalog'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'
import TaskPipelineMini from './TaskPipelineMini.vue'

const props = defineProps<{ taskId: string }>()

const board = useBoardStore()
const execution = useExecutionStore()
const pipelines = usePipelinesStore()
const ui = useUiStore()
const agentRuns = useAgentRunsStore()
const toast = useToast()

const task = computed<Block | undefined>(() => board.getBlock(props.taskId))
const statusMeta = computed(() => (task.value ? STATUS_META[task.value.status] : null))
const selected = computed(() => ui.selectedBlockId === props.taskId)

// ---- dependencies (gate execution order; may point across frames) ----------
const deps = computed(() =>
  (task.value?.dependsOn ?? []).map((id) => board.getBlock(id)).filter((b): b is Block => !!b),
)
/** Deps that haven't merged yet — these block this task from running. */
const unmet = computed(() => board.unmetDeps(props.taskId))
const runnable = computed(() => board.isRunnable(props.taskId))

/** Label a dependency, noting its frame when it lives in another one. */
const { depLabel: labelDep } = useDepLabels()
const depLabel = (dep: Block) => labelDep(dep, task.value?.parentId)

/** The pipeline a plain "Start" will use: the task's pinned pipeline, else the first. */
const defaultPipeline = computed(
  () =>
    (task.value?.pipelineId ? pipelines.getPipeline(task.value.pipelineId) : undefined) ??
    pipelines.pipelines[0],
)

/** The PR the implementer agent opened for this task, if any. */
const pr = computed(() => task.value?.pullRequest)
const prLabel = computed(() => (pr.value?.number ? `PR #${pr.value.number}` : 'PR'))

// This task's current agent run (if any). A failed run must surface the shared
// failure banner + retry — NOT a stuck progress bar — so the card never looks
// like it's still working after the run has terminated.
const agentRun = computed(() => agentRuns.byBlock[props.taskId])
const runFailed = computed(() => agentRun.value?.status === 'failed')

// When this task backs a recurring pipeline, surface a small repeat badge so the
// service shows its scheduled work at a glance (full controls live in the inspector).
const recurring = useRecurringPipelinesStore()
const schedule = computed(() => recurring.byBlock(props.taskId))

// Optimistic "Start": flip the button into a spinning "Starting…" state the
// instant it's clicked, before the server confirms. The button naturally
// unmounts once the stream pushes the block into `in_progress`; if the start
// call faults we revert and surface a toast.
const starting = ref(false)

async function run() {
  if (!runnable.value) {
    toast.add({
      title: 'Blocked by dependencies',
      description: `Waiting on: ${unmet.value.map((d) => d.title).join(', ')}`,
      icon: 'i-lucide-lock',
    })
    return
  }
  const pipeline = defaultPipeline.value
  if (!pipeline) {
    toast.add({ title: 'No pipeline defined', description: 'Create one in the builder first.' })
    return
  }
  starting.value = true
  try {
    // false ⇒ the user cancelled the personal-password prompt; revert quietly (the run
    // never started). On success the button unmounts once the stream pushes in_progress.
    const started = await execution.start(props.taskId, pipeline)
    if (!started) starting.value = false
  } catch (e) {
    // Real confirmation came back as a failure — revert the optimistic state.
    starting.value = false
    toast.add({
      title: 'Failed to start',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
      icon: 'i-lucide-alert-triangle',
    })
  }
}

function review() {
  ui.select(props.taskId)
  ui.focus(props.taskId)
}

function merge() {
  execution.mergePr(props.taskId)
}

// A `blocked` task is waiting on a human for one of two reasons — an agent-raised
// decision OR an approval gate — and both must surface here (a failed run is shown
// separately by the AgentFailureCard above). The board previously only handled
// decisions, so an approval-gated task was a dead end: it read "Decision needed"
// (the old generic `blocked` label) with no badge and a click that did nothing.
const pendingDecision = computed(() =>
  execution.openDecisions.find((d) => d.blockId === props.taskId),
)
const pendingApproval = computed(() =>
  execution.openApprovals.find((a) => a.blockId === props.taskId),
)

/** What this blocked task actually needs from a human — drives the card's label,
 * pulse and action. Decision takes precedence over approval (a step never holds
 * both at once; this is just a stable order). Null when nothing is pending. */
const attention = computed<{
  label: string
  icon: string
  action: string
  open: () => void
} | null>(() => {
  const d = pendingDecision.value
  if (d)
    return {
      label: 'Decision needed',
      icon: 'i-lucide-circle-help',
      action: 'Resolve',
      open: () => ui.openDecision(d.instanceId, d.decision.id),
    }
  const a = pendingApproval.value
  if (a)
    return {
      label: 'Approval needed',
      icon: 'i-lucide-shield-check',
      action: 'Approve',
      open: () => ui.openApprovalDetail(a.instanceId, a.approval.id),
    }
  return null
})

/** Specific header copy: a failed run reads "Failed", a parked task reads its
 * decision/approval reason, otherwise the generic status label. */
const statusText = computed(() =>
  runFailed.value ? 'Failed' : (attention.value?.label ?? statusMeta.value?.label ?? ''),
)

// Clicking the card body only selects the task (opening the inspector so the human can
// interact with it). Whatever the task is parked on — a decision, an approval, or the
// requirements review — is opened explicitly via the action button below, never by a
// click anywhere on the card. (A card-body click used to pop the review window open,
// which got in the way of just inspecting/editing the task.)
function selectTask() {
  ui.select(props.taskId)
}
</script>

<template>
  <div
    v-if="task && statusMeta"
    :data-block-id="task.id"
    class="nodrag w-full cursor-pointer rounded-lg border bg-slate-950/70 p-2 text-left transition"
    :class="[
      selected ? 'border-white' : 'border-slate-700 hover:border-slate-500',
      task.status === 'pr_ready' ? 'board-pulse-green' : attention ? 'board-pulse' : '',
    ]"
    @click.stop="selectTask"
  >
    <!-- header row -->
    <div class="flex items-center gap-1.5">
      <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: statusMeta.color }" />
      <UIcon
        v-if="schedule"
        name="i-lucide-repeat"
        class="h-3 w-3 shrink-0 text-indigo-400"
        :title="schedule.enabled ? 'Recurring pipeline' : 'Recurring pipeline (paused)'"
      />
      <span class="truncate text-[11px] font-semibold text-slate-100">{{ task.title }}</span>
      <span
        class="ml-auto shrink-0 text-[9px] uppercase tracking-wide"
        :class="runFailed ? 'text-rose-400' : attention ? 'text-amber-400' : 'text-slate-500'"
      >
        {{ statusText }}
      </span>
    </div>

    <!-- a failed run: the shared failure banner + retry, never a stuck bar -->
    <AgentFailureCard
      v-if="runFailed && agentRun"
      :run="agentRun"
      variant="compact"
      class="mt-1.5"
    />

    <!-- progress while a pipeline runs (suppressed once the run has failed) -->
    <UProgress
      v-else-if="task.status === 'in_progress' || task.status === 'blocked'"
      :model-value="Math.round(task.progress * 100)"
      size="xs"
      class="mt-1.5"
    />

    <!-- spatial drill-down: build steps (at `steps` zoom) and each step's live
         subtask todos (one band deeper, at `subtasks` zoom) -->
    <TaskPipelineMini :task-id="taskId" />

    <!-- dependencies (run order) -->
    <div v-if="deps.length" class="mt-1.5 flex flex-wrap items-center gap-1">
      <UIcon
        :name="runnable ? 'i-lucide-link' : 'i-lucide-lock'"
        class="h-3 w-3"
        :class="runnable ? 'text-slate-500' : 'text-amber-400'"
      />
      <span
        v-for="d in deps"
        :key="d.id"
        class="inline-flex items-center gap-0.5 rounded bg-slate-800/80 px-1 py-0.5 text-[9px]"
        :class="d.status === 'done' ? 'text-slate-400' : 'text-amber-300'"
        :title="depLabel(d)"
      >
        <UIcon
          :name="d.status === 'done' ? 'i-lucide-check' : 'i-lucide-clock'"
          class="h-2.5 w-2.5"
        />
        <span class="max-w-[110px] truncate">{{ depLabel(d) }}</span>
      </span>
    </div>

    <!-- actions by state -->
    <div class="nodrag mt-2 flex flex-wrap items-center gap-1">
      <!-- parked for a human: a decision to resolve or an approval gate to clear -->
      <UButton
        v-if="attention"
        color="warning"
        variant="soft"
        size="xs"
        :icon="attention.icon"
        @click.stop="attention.open()"
      >
        {{ attention.action }}
      </UButton>

      <template v-if="task.status === 'planned' || task.status === 'ready'">
        <UButton
          :color="runnable ? 'primary' : 'neutral'"
          variant="soft"
          size="xs"
          :icon="runnable ? 'i-lucide-play' : 'i-lucide-lock'"
          :loading="starting"
          :disabled="!runnable || starting"
          :title="
            runnable
              ? `Start ${defaultPipeline?.name ?? 'pipeline'}`
              : `Waiting on: ${unmet.map((d) => d.title).join(', ')}`
          "
          @click.stop="run"
        >
          {{ starting ? 'Starting…' : runnable ? 'Start' : 'Blocked' }}
        </UButton>
        <span
          v-if="runnable && defaultPipeline"
          class="inline-flex items-center gap-0.5 text-[9px] text-slate-500"
        >
          <UIcon name="i-lucide-workflow" class="h-2.5 w-2.5" />{{ defaultPipeline.name }}
        </span>
      </template>

      <template v-if="task.status === 'pr_ready'">
        <UButton
          v-if="pr"
          :to="pr.url"
          target="_blank"
          rel="noopener"
          external
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-git-pull-request"
          :title="`Open ${prLabel} on GitHub`"
          @click.stop
        >
          {{ prLabel }}
        </UButton>
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-scan-eye"
          @click.stop="review"
        >
          Review
        </UButton>
        <UButton
          color="success"
          variant="solid"
          size="xs"
          icon="i-lucide-git-merge"
          @click.stop="merge"
        >
          Merge
        </UButton>
      </template>

      <span
        v-else-if="task.status === 'done'"
        class="inline-flex items-center gap-1 text-[9px] text-emerald-400"
      >
        <UIcon name="i-lucide-check-check" class="h-3 w-3" /> implemented
      </span>
    </div>

    <!-- structural metadata: assigned module -->
    <div
      v-if="task.moduleName"
      class="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-800 pt-2"
    >
      <span
        class="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] text-violet-200"
        :title="`Module: ${task.moduleName}`"
      >
        <UIcon :name="MODULE_META.icon" class="h-3 w-3" :style="{ color: MODULE_META.color }" />
        {{ task.moduleName }}
      </span>
    </div>
  </div>
</template>
