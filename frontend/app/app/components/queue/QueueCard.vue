<script setup lang="ts">
import { agentKindMeta } from '~/utils/catalog'
import { formatDuration } from '~/composables/useStepTimer'
import { LANE_REASON_LABEL_KEYS } from '~/utils/swimlanes'
import type { QueueEntry } from '~/utils/queueSections'
import IconButton from '~/components/common/IconButton.vue'

/**
 * One task in the queue: why it is here, where it lives, and the ONE thing to do about it.
 *
 * The board's card answers "what is this task's state"; this card answers "what do I do next",
 * so it carries a single primary action derived from the lane REASON, and the inspector one
 * click away for everything else. The actions themselves are the board card's
 * (`useTaskActions`), so Start, Resolve and Merge behave identically on both surfaces.
 */
const props = defineProps<{ entry: QueueEntry }>()

const { t } = useI18n()
const ui = useUiStore()
const execution = useExecutionStore()
const agentRuns = useAgentRunsStore()
const preview = useHomePreviewStore()
const access = useWorkspaceAccess()

const taskId = () => props.entry.task.id
const {
  task,
  runnable,
  unmet,
  sandboxed,
  outcomeReadable,
  openOutcome,
  starting,
  start,
  merge,
  pendingDecision,
  reviewStageLabel,
  attention,
} = useTaskActions(taskId)

const reason = computed(() => props.entry.reason)
const run = computed(() => execution.getByBlock(props.entry.task.id) ?? null)
const failure = computed(() => agentRuns.byBlock[props.entry.task.id]?.failure ?? null)

/** The eyebrow's time fact: how long a human has kept it waiting, or how fresh the run is. */
const timeFact = computed(() => {
  const now = Date.now()
  const e = props.entry
  if (reason.value === 'merged' && e.task.completedAt != null)
    return t('queue.card.merged', { duration: formatDuration(now - e.task.completedAt) })
  if (e.waitingSince != null)
    return t('queue.card.waited', { duration: formatDuration(now - e.waitingSince) })
  if ((reason.value === 'running' || reason.value === 'background_review') && e.activityAt != null)
    return t('queue.card.active', { duration: formatDuration(now - e.activityAt) })
  return null
})

/** The step a live run is on, as "step 5 of 9 · Coder". Null when no run is in flight. */
const stepFact = computed(() => {
  const r = run.value
  if (!r || r.steps.length === 0) return null
  const step = r.steps[r.currentStep]
  const position = t('queue.card.step', {
    current: Math.min(r.currentStep + 1, r.steps.length),
    total: r.steps.length,
  })
  return step ? `${position} · ${agentKindMeta(step.agentKind).label}` : position
})

/** One line of context: what the human would want to know before pressing the button. */
const context = computed<string | null>(() => {
  switch (reason.value) {
    case 'decision':
      return pendingDecision.value?.decision.question ?? null
    case 'failed':
      return failure.value?.message ?? null
    case 'budget_paused':
      return t('queue.card.budgetPaused')
    case 'parked':
    case 'unclassified':
      return t('queue.card.parked')
    case 'dependencies':
      return t('queue.card.waitingOn', { deps: unmet.value.map((d) => d.title).join(', ') })
    case 'background_review':
      return reviewStageLabel.value
    default:
      return null
  }
})

/**
 * The eyebrow's first word. The lane reason, except in the merge column, whose header already says
 * "ready to merge": there the pull request's own number is the more useful fact.
 */
const eyebrow = computed(() => {
  const pr = props.entry.task.pullRequest
  if (reason.value === 'pr_awaiting_merge' && pr?.number)
    return t('queue.card.pr', { number: pr.number })
  return t(LANE_REASON_LABEL_KEYS[reason.value])
})

const showProgress = computed(
  () => reason.value === 'running' || reason.value === 'background_review',
)

const retrying = ref(false)
async function retry() {
  const runId = agentRuns.byBlock[props.entry.task.id]?.runId
  if (!runId || retrying.value) return
  retrying.value = true
  try {
    // The store surfaces any failure as an actionable toast.
    await agentRuns.retry(runId)
  } finally {
    retrying.value = false
  }
}

function openTask() {
  ui.select(props.entry.task.id)
}

/** Leave the queue for the canvas, with this task selected. */
function showOnBoard() {
  preview.show('board')
  ui.select(props.entry.task.id)
}
</script>

<template>
  <article
    v-if="task"
    class="rounded-lg border border-muted bg-default p-3"
    :class="ui.selectedBlockId === task.id ? 'border-inverted' : ''"
    data-testid="queue-card"
    :data-block-id="task.id"
    :data-reason="reason"
  >
    <div class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-dimmed">
      <span
        class="shrink-0 font-semibold whitespace-nowrap"
        :class="
          reason === 'failed'
            ? 'text-error'
            : entry.reason === 'pr_awaiting_merge'
              ? 'text-success'
              : 'text-highlighted'
        "
      >
        {{ eyebrow }}
      </span>
      <span v-if="entry.service" class="min-w-0 truncate">· {{ entry.service.title }}</span>
      <span v-if="timeFact" class="shrink-0 whitespace-nowrap">· {{ timeFact }}</span>
      <IconButton
        class="ms-auto shrink-0"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-map"
        :label="t('queue.card.showOnBoard')"
        @click="showOnBoard"
      />
    </div>

    <!-- The title opens the task: the one always-present target, like the board card's. -->
    <UButton
      color="neutral"
      variant="link"
      class="mt-1 w-full p-0 text-start text-sm font-semibold leading-snug text-highlighted"
      data-testid="queue-card-title"
      @click="openTask"
    >
      {{ task.title }}
    </UButton>

    <p v-if="context" class="mt-1 line-clamp-2 text-xs text-muted" :title="context">
      {{ context }}
    </p>

    <div v-if="showProgress" class="mt-2 space-y-1">
      <UProgress :model-value="Math.round(task.progress * 100)" size="xs" />
      <p v-if="stepFact" class="text-2xs text-dimmed">{{ stepFact }}</p>
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <!-- Parked on a decision or an approval: the gate itself, one click away. -->
      <UButton
        v-if="attention"
        color="warning"
        size="xs"
        :icon="attention.icon"
        data-testid="queue-card-primary"
        @click="attention.open()"
      >
        {{ reason === 'decision' ? t('queue.card.answer') : attention.action }}
      </UButton>

      <UButton
        v-else-if="reason === 'failed'"
        color="error"
        size="xs"
        icon="i-lucide-rotate-ccw"
        :loading="retrying"
        :disabled="!access.canExecuteRuns.value"
        data-testid="queue-card-primary"
        @click="retry"
      >
        {{ t('queue.card.retry') }}
      </UButton>

      <template v-else-if="reason === 'pr_awaiting_merge'">
        <UButton
          v-if="outcomeReadable"
          size="xs"
          icon="i-lucide-clipboard-check"
          data-testid="queue-card-primary"
          @click="openOutcome"
        >
          {{ t('board.task.readOutcome') }}
        </UButton>
        <UButton
          color="success"
          :variant="outcomeReadable ? 'outline' : 'solid'"
          size="xs"
          icon="i-lucide-git-merge"
          :disabled="!access.canExecuteRuns.value"
          @click="merge"
        >
          {{ t('board.task.merge') }}
        </UButton>
      </template>

      <UButton
        v-else-if="reason === 'unstarted'"
        size="xs"
        :icon="sandboxed ? 'i-lucide-shield' : 'i-lucide-play'"
        :loading="starting"
        :disabled="!runnable || starting || !access.canExecuteRuns.value"
        data-testid="queue-card-primary"
        @click="start"
      >
        {{ starting ? t('board.task.starting') : t('board.task.start') }}
      </UButton>

      <UButton
        v-else-if="reason === 'merged' && outcomeReadable"
        size="xs"
        variant="soft"
        icon="i-lucide-clipboard-check"
        data-testid="queue-card-primary"
        @click="openOutcome"
      >
        {{ t('board.task.readOutcome') }}
      </UButton>

      <UButton
        color="neutral"
        variant="outline"
        size="xs"
        data-testid="queue-card-open"
        @click="openTask"
      >
        {{ t('queue.card.openTask') }}
      </UButton>
    </div>
  </article>
</template>
