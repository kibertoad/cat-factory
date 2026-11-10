<script setup lang="ts">
import type { AgentState, PipelineStep } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'

// Where an in-flight run is, on the card itself: the step it is on, its position, and one
// segment per step coloured by that step's state. It replaces the bare progress bar, and it is
// the same height at every zoom and whether the card is hovered or not, so nothing on the board
// moves when the pointer arrives (UXA-01). The named list of steps is in the inspector, and on
// the card past the `steps` zoom band (`TaskPipelineMini`).
//
// Renders nothing until the run has steps, so the card keeps its plain bar for that moment.
const props = defineProps<{ taskId: string }>()

const execution = useExecutionStore()
const reviews = useReviewStage()
const { t } = useI18n()

const instance = computed(() => execution.getByBlock(props.taskId))
const steps = computed(() => instance.value?.steps ?? [])
const index = computed(() =>
  Math.min(Math.max(instance.value?.currentStep ?? 0, 0), steps.value.length - 1),
)
const current = computed(() => steps.value[index.value])

/** Segment colour per step state, the same accents the step list uses. */
const STATE_COLOR: Record<AgentState, string> = {
  pending: 'var(--ui-border-accented)',
  working: 'var(--ui-primary)',
  waiting_decision: 'var(--ui-warning)',
  done: 'var(--ui-success)',
}

// A reviewer gate folding answers in the background parks in `waiting_decision` but needs no
// human, so it reads as working, as it does in the step list.
function segmentColor(s: PipelineStep) {
  if (reviews.isBackground(s.agentKind, props.taskId)) return STATE_COLOR.working
  return STATE_COLOR[s.state]
}
</script>

<template>
  <div v-if="current" class="space-y-1" data-testid="task-progress-row">
    <div class="flex items-center gap-1 text-3xs">
      <span
        class="truncate font-medium text-default"
        :title="`${agentKindMeta(current.agentKind).label}: ${agentKindMeta(current.agentKind).description}`"
      >
        {{ agentKindMeta(current.agentKind).label }}
      </span>
      <span class="ms-auto shrink-0 tabular-nums text-muted">
        {{ t('board.task.stepPosition', { current: index + 1, total: steps.length }) }}
      </span>
    </div>
    <div class="flex items-center gap-0.5" aria-hidden="true">
      <span
        v-for="(s, i) in steps"
        :key="i"
        class="h-1 flex-1 rounded-full"
        :style="{ backgroundColor: segmentColor(s) }"
      />
    </div>
  </div>
</template>
