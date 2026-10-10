<script setup lang="ts">
import type { Block } from '~/types/domain'
import { STATUS_META, MODULE_META, taskTypeMeta } from '~/utils/catalog'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'
import TaskPipelineMini from './TaskPipelineMini.vue'
import IconButton from '~/components/common/IconButton.vue'

const props = defineProps<{ taskId: string }>()

const board = useBoardStore()
const ui = useUiStore()
const agentRuns = useAgentRunsStore()
const { t } = useI18n()

// What the card offers a human to do, shared with the queue's card (see `useTaskActions`).
const {
  task,
  sandboxed,
  unmet,
  runnable,
  defaultPipeline,
  outcomeReadable,
  openOutcome,
  starting,
  start: run,
  merge,
  reviewStage,
  reviewStageLabel,
  attention,
} = useTaskActions(() => props.taskId)
const statusMeta = computed(() => (task.value ? STATUS_META[task.value.status] : null))

// A type badge for any NON-default task type — built-in (bug/document/spike/review/ralph) or a
// deployment CUSTOM type (resolved through the `taskTypeMeta` read-model, which degrades an
// unregistered namespaced type to the `feature` presentation, so a stale id never breaks the card).
// `feature` is the implicit default and shows no badge to keep ordinary cards uncluttered. A
// built-in type's label is an i18n key; a custom type's is a literal from its wire presentation.
const typeBadge = computed(() => {
  const tt = task.value?.taskType
  if (!tt || tt === 'feature') return null
  const meta = taskTypeMeta(tt)
  return {
    icon: meta.icon,
    color: meta.color,
    label: meta.labelKey ? t(meta.labelKey) : (meta.label ?? tt),
  }
})
const selected = computed(() => ui.selectedBlockId === props.taskId)

// Drag-to-connect: dragging from this card's handle onto another task makes THAT task
// depend on this one (this is the prerequisite). The composable tracks the gesture.
const { start: startConnect } = useDependencyConnect()

// ---- dependencies (gate execution order; may point across frames) ----------
const deps = computed(() =>
  (task.value?.dependsOn ?? []).map((id) => board.getBlock(id)).filter((b): b is Block => !!b),
)
const uiMode = useUiModeStore()

/** Label a dependency, noting its frame when it lives in another one. */
const { depLabel: labelDep } = useDepLabels()
const depLabel = (dep: Block) => labelDep(dep, task.value?.parentId)

/** The PR the implementer agent opened for this task, if any. */
const pr = computed(() => task.value?.pullRequest)
const prLabel = computed(() =>
  pr.value?.number ? t('board.task.prNumber', { number: pr.value.number }) : t('board.task.pr'),
)

const laneView = useLaneViewStore()
/**
 * Reading the result starts at the OUTCOME summary (what changed in product terms, with the
 * captured evidence), and the pull request is one click inside it. In BASIC mode that replaces
 * the card's raw PR chip: the diff is still exactly as reachable, through a surface that says
 * what the diff is about first. Advanced mode keeps both, since a reader who wants the diff
 * directly is the reader that tier is for.
 *
 * The card's raw pull-request chip, which basic mode drops in favour of the outcome card
 * carrying the same link at the top. Written as the INVARIANT ("the diff never stops being
 * reachable from this card") rather than as `isAdvanced` alone, so the tier can only ever
 * reorder two routes and never remove the last one: where the outcome card is not offered,
 * the chip stays in both tiers.
 */
const showPrChip = computed(
  () => Boolean(pr.value) && (uiMode.isAdvanced || !outcomeReadable.value),
)

/**
 * The module chip, dropped while the swimlanes are GROUPED by module.
 *
 * Written as the invariant ("the card names its module wherever nothing else does") for the same
 * reason `showPrChip` is: the surface that carries the other half is itself conditional, and two
 * predicates that have to agree by coincidence eventually do not.
 */
const showModuleChip = computed(
  () => Boolean(task.value?.moduleName) && laneView.groupKey !== 'module',
)
// This task's current agent run (if any). A failed run must surface the shared
// failure banner + retry — NOT a stuck progress bar — so the card never looks
// like it's still working after the run has terminated.
const agentRun = computed(() => agentRuns.byBlock[props.taskId])
const runFailed = computed(() => agentRun.value?.status === 'failed')

// When this task backs a recurring pipeline, surface a small repeat badge so the
// service shows its scheduled work at a glance (full controls live in the inspector).
const recurring = useRecurringPipelinesStore()
const schedule = computed(() => recurring.byBlock(props.taskId))

/** Specific header copy: a failed run reads "Failed", a parked task reads its
 * decision/approval reason, otherwise the generic status label. */
const statusText = computed(() =>
  runFailed.value
    ? t('board.task.failed')
    : (reviewStageLabel.value ?? attention.value?.label ?? statusMeta.value?.label ?? ''),
)

function review() {
  ui.select(props.taskId)
  ui.focus(props.taskId)
}

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
    :data-status="task.status"
    :data-task-type="task.taskType"
    data-testid="task-card"
    class="nodrag w-full cursor-pointer rounded-lg border bg-app-950/70 p-2 text-start transition"
    :class="[
      selected ? 'border-inverted' : 'border-muted hover:border-app-500',
      task.status === 'pr_ready' ? 'board-pulse-green' : attention ? 'board-pulse' : '',
    ]"
    @click.stop="selectTask"
  >
    <!-- meta row: status dot, recurring icon, status label + connect handle. The
         status label is a fixed-width-ish stub ("APPROVAL NEEDED" etc.), so it sits
         on its own row rather than stealing horizontal space from the title. -->
    <div class="flex items-center gap-1.5">
      <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: statusMeta.color }" />
      <!-- Task-type badge (non-`feature` only): the type's icon, tinted with its accent, label on
           hover. Renders a built-in OR a deployment-registered custom type via `taskTypeMeta`. -->
      <span
        v-if="typeBadge"
        class="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm"
        :style="{ color: typeBadge.color, backgroundColor: tint(typeBadge.color) }"
        :title="typeBadge.label"
        :data-task-type-badge="task.taskType"
        data-testid="task-type-badge"
      >
        <UIcon :name="typeBadge.icon" class="h-2.5 w-2.5" />
      </span>
      <UIcon
        v-if="schedule"
        name="i-lucide-repeat"
        class="h-3 w-3 shrink-0 text-primary"
        :title="
          schedule.enabled
            ? t('board.task.recurringPipeline')
            : t('board.task.recurringPipelinePaused')
        "
      />
      <span
        class="ms-auto truncate text-3xs uppercase tracking-wide"
        :class="
          runFailed
            ? 'text-app-error-400'
            : reviewStage
              ? 'text-primary'
              : attention
                ? 'text-app-warning-400'
                : 'text-dimmed'
        "
      >
        {{ statusText }}
      </span>
      <!-- drag-to-connect handle: drag onto another task to make it depend on this one -->
      <IconButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-spline"
        class="nodrag shrink-0"
        :label="t('board.task.dragToConnect')"
        :ui="{
          base: 'cursor-crosshair touch-none rounded-full p-0.5 text-dimmed hover:bg-elevated hover:text-app-warning-400 pointer-coarse:p-2.5',
          leadingIcon: 'h-3 w-3 pointer-coarse:h-5 pointer-coarse:w-5',
        }"
        @pointerdown.stop="startConnect(task.id, $event)"
        @click.stop
      />
    </div>

    <!-- title gets a full-width row so long titles wrap to two lines rather than
         truncating to an unreadable stub; the full text stays available on hover.

         It is also the card's SELECTION affordance for tests: every action button below stops
         propagation, so a click resolved to one of them never reaches `selectTask`, and the
         title is the one always-rendered part of the body that no control can occupy. -->
    <div
      data-testid="task-title"
      class="mt-1 line-clamp-2 break-words text-2xs font-semibold leading-snug text-app-100"
      :title="task.title"
    >
      {{ task.title }}
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
        :class="runnable ? 'text-dimmed' : 'text-app-warning-400'"
      />
      <span
        v-for="d in deps"
        :key="d.id"
        class="inline-flex items-center gap-0.5 rounded-sm bg-elevated/80 px-1 py-0.5 text-3xs"
        :class="d.status === 'done' ? 'text-muted' : 'text-app-warning-300'"
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
      <!-- a reviewer gate folding/re-reviewing in the background: a working indicator,
           NOT a gate — the human is back on the board and summoned only if input is needed -->
      <span v-if="reviewStage" class="inline-flex items-center gap-1 text-3xs text-primary">
        <UIcon name="i-lucide-loader-circle" class="h-3 w-3 animate-spin" />
        {{ reviewStageLabel }}
      </span>

      <!-- parked for a human: a decision to resolve or an approval gate to clear -->
      <UButton
        v-if="attention"
        color="warning"
        variant="soft"
        size="xs"
        data-testid="task-resolve"
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
          :icon="!runnable ? 'i-lucide-lock' : sandboxed ? 'i-lucide-shield' : 'i-lucide-play'"
          :loading="starting"
          :disabled="!runnable || starting"
          data-testid="task-start"
          :title="
            !runnable
              ? t('board.task.waitingOn', { deps: unmet.map((d) => d.title).join(', ') })
              : sandboxed
                ? t('board.task.startPipelineDryRun', {
                    name: defaultPipeline?.name ?? t('board.task.pipelineFallback'),
                  })
                : t('board.task.startPipeline', {
                    name: defaultPipeline?.name ?? t('board.task.pipelineFallback'),
                  })
          "
          @click.stop="run"
        >
          {{
            starting
              ? t('board.task.starting')
              : runnable
                ? t('board.task.start')
                : t('board.task.blocked')
          }}
        </UButton>
        <span
          v-if="runnable && defaultPipeline"
          class="inline-flex items-center gap-0.5 text-3xs text-dimmed"
        >
          <UIcon name="i-lucide-workflow" class="h-2.5 w-2.5" />{{ defaultPipeline.name }}
        </span>
      </template>

      <template v-if="task.status === 'pr_ready'">
        <UButton
          v-if="outcomeReadable"
          color="primary"
          variant="soft"
          size="xs"
          icon="i-lucide-clipboard-check"
          :title="t('board.task.readOutcomeHint')"
          data-testid="task-open-outcome"
          @click.stop="openOutcome"
        >
          {{ t('board.task.readOutcome') }}
        </UButton>
        <UButton
          v-if="showPrChip"
          :to="pr?.url"
          target="_blank"
          rel="noopener"
          external
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-git-pull-request"
          :title="t('board.task.openPrLink', { pr: prLabel })"
          @click.stop
        >
          {{ prLabel }}
        </UButton>
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-scan-eye"
          data-testid="task-review"
          @click.stop="review"
        >
          {{ t('board.task.review') }}
        </UButton>
        <UButton
          color="success"
          variant="solid"
          size="xs"
          icon="i-lucide-git-merge"
          @click.stop="merge"
        >
          {{ t('board.task.merge') }}
        </UButton>
      </template>

      <!-- A merged task is the one people come back to READ, so its result stays openable
           rather than collapsing to a tick the moment it lands. -->
      <template v-else-if="task.status === 'done'">
        <span class="inline-flex items-center gap-1 text-3xs text-app-success-400">
          <UIcon name="i-lucide-check-check" class="h-3 w-3" /> {{ t('board.task.implemented') }}
        </span>
        <UButton
          v-if="outcomeReadable"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-clipboard-check"
          :title="t('board.task.readOutcomeHint')"
          data-testid="task-open-outcome"
          @click.stop="openOutcome"
        >
          {{ t('board.task.readOutcome') }}
        </UButton>
      </template>
    </div>

    <!-- Structural metadata: assigned module. Dropped while the lanes are GROUPED by module,
         where the group header above the card already names it — two chips saying the same thing
         cost a row of card height each and add nothing. -->
    <div
      v-if="showModuleChip"
      class="mt-2 flex flex-wrap items-center gap-1 border-t border-default pt-2"
    >
      <span
        class="inline-flex items-center gap-1 rounded-sm bg-app-secondary-500/15 px-1.5 py-0.5 text-3xs text-app-secondary-200"
        :title="t('board.task.module', { name: task.moduleName })"
      >
        <UIcon :name="MODULE_META.icon" class="h-3 w-3" :style="{ color: MODULE_META.color }" />
        {{ task.moduleName }}
      </span>
    </div>
  </div>
</template>
