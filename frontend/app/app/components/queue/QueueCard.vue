<script setup lang="ts">
import { agentKindMeta } from '~/utils/catalog'
import { formatDuration, useNowTick } from '~/composables/useStepTimer'
import { useFramePlacement } from '~/composables/useFramePlacement'
import { LANE_REASON_LABEL_KEYS } from '~/utils/swimlanes'
import type { QueueEntry } from '~/utils/queueSections'
import IconButton from '~/components/common/IconButton.vue'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'

/**
 * One task in the queue: why it is here, where it lives, and the ONE thing to do about it.
 *
 * The board's card answers "what is this task's state"; this card answers "what do I do next",
 * so it carries a single primary action derived from the lane REASON, and the inspector one
 * click away for everything else. The actions themselves are the board card's
 * (`useTaskActions`), so Start, Resolve and Merge behave identically on both surfaces, and a failed
 * run shows the same `AgentFailureCard` the board card shows, with its Retry.
 *
 * Every action is `soft`, as on the board card: the queue lists many cards at once, and a solid
 * button on each would put many primaries in one view.
 */
const props = defineProps<{ entry: QueueEntry }>()

const { t } = useI18n()
const ui = useUiStore()
const execution = useExecutionStore()
const agentRuns = useAgentRunsStore()
const views = useWorkViewStore()
const { focusFrame } = useFramePlacement()
// A shared 30s clock, so "waited 4m" advances on a quiet board instead of freezing until some
// unrelated event re-evaluates the card.
const nowTick = useNowTick(30_000)

const taskId = () => props.entry.task.id
const {
  task,
  runnable,
  canExecute,
  executeDeniedTitle,
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
const agentRun = computed(() => agentRuns.byBlock[props.entry.task.id])
const runFailed = computed(() => agentRun.value?.status === 'failed')

/** The eyebrow's time fact: how long a human has kept it waiting, or how fresh the run is. */
const timeFact = computed(() => {
  const now = nowTick.value
  // The clock reads 0 until the card has mounted and subscribed.
  if (!now) return null
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

function openTask() {
  ui.select(props.entry.task.id)
}

/**
 * Leave the queue for the canvas, with this task selected and its service in view. The canvas
 * kept its own camera while the queue covered it, so without the pan the task is usually off
 * screen. A task has no position of its own (it lives in its frame's swimlanes), so the camera
 * centres on the frame.
 */
function showOnBoard() {
  views.show('board')
  ui.select(props.entry.task.id)
  void focusFrame(props.entry.service?.id ?? props.entry.task.id)
}
</script>

<template>
  <!-- The whole card opens the task. The title is the card's one real button, so keyboard focus
       and the accessible name stay on it, and its `::after` stretches the click target over the
       card. Every other control sits above that overlay (`relative z-10`) and keeps its own
       action. -->
  <article
    v-if="task"
    class="relative rounded-lg border bg-default p-3 transition hover:border-accented has-[[data-card-target]:focus-visible]:ring-2 has-[[data-card-target]:focus-visible]:ring-primary"
    :class="ui.selectedBlockId === task.id ? 'border-inverted' : 'border-muted'"
    data-testid="queue-card"
    :data-queue-task="task.id"
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
        class="relative z-10 ms-auto shrink-0"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-map"
        :label="t('queue.card.showOnBoard')"
        @click="showOnBoard"
      />
    </div>

    <!-- The title opens the task, and through its stretched `::after`, so does the whole card. -->
    <UButton
      color="neutral"
      variant="link"
      class="mt-1 w-full p-0 text-start text-sm font-semibold leading-snug text-highlighted cursor-pointer after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none"
      data-card-target
      data-testid="queue-card-title"
      @click="openTask"
    >
      {{ task.title }}
    </UButton>

    <p v-if="context" class="mt-1 line-clamp-2 text-xs text-muted" :title="context">
      {{ context }}
    </p>

    <!-- A failed run: the same failure banner and Retry the board card shows. -->
    <AgentFailureCard
      v-if="reason === 'failed' && runFailed && agentRun"
      :run="agentRun"
      variant="compact"
      class="relative z-10 mt-2"
    />

    <div v-if="showProgress" class="mt-2 space-y-1">
      <UProgress :model-value="Math.round(task.progress * 100)" size="xs" />
      <p v-if="stepFact" class="text-2xs text-dimmed">{{ stepFact }}</p>
    </div>

    <div class="relative z-10 mt-3 flex flex-wrap items-center gap-2 empty:hidden">
      <!-- Parked on a decision or an approval: the gate itself, one click away. -->
      <UButton
        v-if="attention"
        color="warning"
        variant="soft"
        size="xs"
        :icon="attention.icon"
        data-testid="queue-card-primary"
        @click="attention.open()"
      >
        {{ reason === 'decision' ? t('queue.card.answer') : attention.action }}
      </UButton>

      <template v-else-if="reason === 'pr_awaiting_merge'">
        <UButton
          v-if="outcomeReadable"
          variant="soft"
          size="xs"
          icon="i-lucide-clipboard-check"
          data-testid="queue-card-primary"
          @click="openOutcome"
        >
          {{ t('board.task.readOutcome') }}
        </UButton>
        <UButton
          color="success"
          :variant="outcomeReadable ? 'outline' : 'soft'"
          size="xs"
          icon="i-lucide-git-merge"
          :disabled="!canExecute"
          :title="executeDeniedTitle"
          @click="merge"
        >
          {{ t('board.task.merge') }}
        </UButton>
      </template>

      <UButton
        v-else-if="reason === 'unstarted'"
        variant="soft"
        size="xs"
        :icon="sandboxed ? 'i-lucide-shield' : 'i-lucide-play'"
        :loading="starting"
        :disabled="!runnable || starting || !canExecute"
        :title="executeDeniedTitle"
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
    </div>
  </article>
</template>
