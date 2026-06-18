<script setup lang="ts">
import type { Block } from '~/types/domain'
import {
  STATUS_META,
  FEATURE_META,
  MODULE_META,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from '~/utils/catalog'
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
const features = computed(() => task.value?.features ?? [])
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

const threshold = computed(() => task.value?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD)
/** The pipeline a plain "Start" will use (first defined pipeline). */
const defaultPipeline = computed(() => pipelines.pipelines[0])
const confidencePct = computed(() =>
  task.value?.confidence != null ? Math.round(task.value.confidence * 100) : null,
)

/** The PR the implementer agent opened for this task, if any. */
const pr = computed(() => task.value?.pullRequest)
const prLabel = computed(() => (pr.value?.number ? `PR #${pr.value.number}` : 'PR'))

// This task's current agent run (if any). A failed run must surface the shared
// failure banner + retry — NOT a stuck progress bar — so the card never looks
// like it's still working after the run has terminated.
const agentRun = computed(() => agentRuns.byBlock[props.taskId])
const runFailed = computed(() => agentRun.value?.status === 'failed')

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
  const pipeline = pipelines.pipelines[0]
  if (!pipeline) {
    toast.add({ title: 'No pipeline defined', description: 'Create one in the builder first.' })
    return
  }
  starting.value = true
  try {
    await execution.start(props.taskId, pipeline)
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

// A task with an unresolved decision: clicking it jumps straight to the modal.
const pendingDecision = computed(() =>
  execution.openDecisions.find((d) => d.blockId === props.taskId),
)

function selectTask() {
  ui.select(props.taskId)
  const d = pendingDecision.value
  if (d) ui.openDecision(d.instanceId, d.decision.id)
}
</script>

<template>
  <div
    v-if="task && statusMeta"
    :data-block-id="task.id"
    class="nodrag w-full cursor-pointer rounded-lg border bg-slate-950/70 p-2 text-left transition"
    :class="[
      selected ? 'border-white' : 'border-slate-700 hover:border-slate-500',
      task.status === 'pr_ready' ? 'board-pulse-green' : '',
    ]"
    @click.stop="selectTask"
  >
    <!-- header row -->
    <div class="flex items-center gap-1.5">
      <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: statusMeta.color }" />
      <span class="truncate text-[11px] font-semibold text-slate-100">{{ task.title }}</span>
      <span class="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-slate-500">
        {{ statusMeta.label }}
      </span>
    </div>

    <!-- a failed run: the shared failure banner + retry, never a stuck bar -->
    <AgentFailureCard v-if="runFailed && agentRun" :run="agentRun" variant="compact" class="mt-1.5" />

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

    <!-- confidence vs threshold (once scored) -->
    <div v-if="confidencePct != null" class="mt-1.5 flex items-center gap-1 text-[9px]">
      <UIcon name="i-lucide-gauge" class="h-3 w-3 text-slate-500" />
      <span :class="task.confidence! >= threshold ? 'text-emerald-400' : 'text-amber-400'">
        {{ confidencePct }}% conf
      </span>
      <span class="text-slate-600">· need {{ Math.round(threshold * 100) }}%</span>
    </div>

    <!-- actions by state -->
    <div class="nodrag mt-2 flex flex-wrap items-center gap-1">
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

    <!-- structural metadata: assigned module + implemented features -->
    <div
      v-if="task.moduleName || features.length"
      class="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-800 pt-2"
    >
      <span
        v-if="task.moduleName"
        class="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] text-violet-200"
        :title="`Module: ${task.moduleName}`"
      >
        <UIcon :name="MODULE_META.icon" class="h-3 w-3" :style="{ color: MODULE_META.color }" />
        {{ task.moduleName }}
      </span>
      <span
        v-for="f in features"
        :key="f"
        class="inline-flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] text-slate-200"
        :title="`Feature: ${f}`"
      >
        <UIcon :name="FEATURE_META.icon" class="h-3 w-3" :style="{ color: FEATURE_META.color }" />
        <span class="max-w-[110px] truncate">{{ f }}</span>
      </span>
    </div>
  </div>
</template>
