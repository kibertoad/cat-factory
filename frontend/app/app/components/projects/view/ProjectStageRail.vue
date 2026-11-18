<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  DECISIONS_TASK_TYPE,
  type Project,
  type ProjectBoardView,
  type ProjectStageStatus,
  type ProjectStageView,
  type StageCriterionStatus,
} from '@cat-factory/contracts'
import ProjectStageDecisions from '~/components/projects/view/ProjectStageDecisions.vue'
import type { BadgeColor } from '~/utils/badge'

// A staged project's stages in the definition's order, each with where it stands: what it waits
// on, the task working on it, whether an upstream result it built on changed (stale), and the
// report on its newest result against its acceptance criteria. A person starts a ready stage and
// accepts a result at its checkpoint here; a decisions stage is settled item by item as it is
// accepted. Nothing about a stage is stored: the board view derives it.

const props = defineProps<{ project: Project; board: ProjectBoardView }>()
const { t, te } = useI18n()
const projectViews = useProjectViewsStore()
const blocks = useBoardStore()
const errors = usePipelineErrorToast()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()

const STATUS_COLOR: Record<ProjectStageStatus, BadgeColor> = {
  blocked: 'neutral',
  ready: 'info',
  'in-progress': 'primary',
  'awaiting-checkpoint': 'warning',
  done: 'success',
}
const CRITERION_ICON: Record<StageCriterionStatus, { icon: string; class: string }> = {
  met: { icon: 'i-lucide-circle-check', class: 'text-success' },
  unmet: { icon: 'i-lucide-circle-x', class: 'text-error' },
  unverified: { icon: 'i-lucide-circle-help', class: 'text-warning' },
}

const titles = computed(
  () => new Map(props.board.stages.map((view) => [view.stage.id, view.stage.title] as const)),
)
// The stages with a request in flight, each tracked on its own.
const busy = ref<ReadonlySet<string>>(new Set())

function taskTypeLabel(taskType: string): string {
  const key = `board.addTask.types.${taskType}`
  return te(key) ? t(key) : taskType
}

function startable(view: ProjectStageView): boolean {
  return view.state.status === 'ready' || (view.state.status === 'done' && view.stage.repeatable)
}

async function act(stageId: string, action: () => Promise<void>, failureKey: string) {
  busy.value = new Set([...busy.value, stageId])
  try {
    await action()
  } catch (e) {
    errors.present(e, failureKey)
    return
  } finally {
    busy.value = new Set([...busy.value].filter((id) => id !== stageId))
  }
  await refresh()
}

/** Re-read the project after an action went through; a failed re-read is its own failure. */
async function refresh() {
  try {
    await projectViews.load(props.project.id)
  } catch (e) {
    errors.present(e, 'projects.view.loadFailed')
  }
}

// Starting a stage creates its task and starts its run, as an automatic stage's start does.
const start = (view: ProjectStageView) =>
  act(
    view.stage.id,
    async () => {
      const task = await projectViews.startStage(props.project.id, view.stage.id)
      if (!task.pipelineId) return
      const name = pipelines.getPipeline(task.pipelineId)?.name ?? task.pipelineId
      await execution.start(task.id, { id: task.pipelineId, name })
    },
    'projects.view.stages.startFailed',
  )
const accept = (view: ProjectStageView) =>
  act(
    view.stage.id,
    () => projectViews.acceptStage(props.project.id, view.stage.id),
    'projects.view.stages.acceptFailed',
  )
</script>

<template>
  <ol class="space-y-3" data-testid="project-stage-rail">
    <li
      v-for="view in board.stages"
      :key="view.stage.id"
      class="rounded-lg border border-default p-4"
      data-testid="project-stage"
      :data-stage-id="view.stage.id"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-semibold text-highlighted">{{ view.stage.title }}</span>
        <UBadge color="neutral" variant="subtle" size="sm">
          {{ taskTypeLabel(view.stage.taskType) }}
        </UBadge>
        <UBadge
          :color="STATUS_COLOR[view.state.status]"
          variant="subtle"
          size="sm"
          data-testid="project-stage-status"
        >
          {{ t(`projects.view.stages.status.${view.state.status}`) }}
        </UBadge>
        <UBadge v-if="view.state.stale" color="warning" variant="outline" size="sm">
          {{ t('projects.view.stages.stale') }}
        </UBadge>
        <div class="ms-auto flex items-center gap-2">
          <UButton
            v-if="startable(view)"
            icon="i-lucide-play"
            size="xs"
            :loading="busy.has(view.stage.id)"
            data-testid="project-stage-start"
            @click="start(view)"
          >
            {{ t('projects.view.stages.start') }}
          </UButton>
          <UButton
            v-if="view.state.status === 'awaiting-checkpoint' && view.revision !== 'required'"
            icon="i-lucide-check"
            size="xs"
            color="warning"
            variant="subtle"
            :loading="busy.has(view.stage.id)"
            data-testid="project-stage-accept"
            @click="accept(view)"
          >
            {{ t('projects.view.stages.accept') }}
          </UButton>
        </div>
      </div>
      <p v-if="view.stage.description" class="mt-1 text-xs text-muted">
        {{ view.stage.description }}
      </p>
      <p v-if="view.state.waitingOn.length" class="mt-2 text-xs text-dimmed">
        {{
          t('projects.view.stages.waitingOn', {
            stages: view.state.waitingOn.map((id) => titles.get(id) ?? id).join(', '),
          })
        }}
      </p>
      <p v-if="view.state.activeTaskId" class="mt-2 text-xs text-dimmed">
        {{
          t('projects.view.stages.activeTask', {
            task: blocks.getBlock(view.state.activeTaskId)?.title ?? view.state.activeTaskId,
          })
        }}
      </p>
      <p v-if="view.state.stale && startable(view)" class="mt-2 text-xs text-warning">
        {{ t('projects.view.stages.staleHint') }}
      </p>

      <div v-if="view.state.acceptance" class="mt-3" data-testid="project-stage-acceptance">
        <p class="text-xs font-medium text-muted">
          {{ t(`projects.view.stages.acceptance.state.${view.state.acceptance.state}`) }}
        </p>
        <p v-if="view.state.acceptance.note" class="mt-1 text-xs text-dimmed">
          {{ view.state.acceptance.note }}
        </p>
        <ul class="mt-2 space-y-1">
          <li
            v-for="criterion in view.state.acceptance.criteria"
            :key="criterion.id"
            class="flex items-start gap-2 text-xs"
            data-testid="project-stage-criterion"
          >
            <UIcon
              :name="CRITERION_ICON[criterion.status].icon"
              :class="['mt-0.5 size-4 shrink-0', CRITERION_ICON[criterion.status].class]"
              :aria-label="t(`projects.view.stages.acceptance.criterion.${criterion.status}`)"
            />
            <div class="min-w-0">
              <p class="text-default">{{ criterion.statement }}</p>
              <p v-if="criterion.rationale" class="text-dimmed">{{ criterion.rationale }}</p>
              <p v-if="criterion.unfound.length" class="text-warning">
                {{
                  t('projects.view.stages.acceptance.unfound', { count: criterion.unfound.length })
                }}
              </p>
            </div>
          </li>
        </ul>
      </div>

      <template v-if="view.state.status === 'awaiting-checkpoint' && view.revision === 'required'">
        <ProjectStageDecisions
          v-if="view.stage.taskType === DECISIONS_TASK_TYPE && view.state.latest"
          :key="view.state.latest.id"
          :project="project"
          :stage-id="view.stage.id"
          :outcome-id="view.state.latest.id"
          @accepted="refresh"
        />
        <p v-else class="mt-3 text-xs text-dimmed">
          {{ t('projects.view.stages.revisionElsewhere') }}
        </p>
      </template>
    </li>
  </ol>
</template>
