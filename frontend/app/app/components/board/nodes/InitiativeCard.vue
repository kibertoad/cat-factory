<script setup lang="ts">
// The board card for an `initiative`-level block (a frame child, like a module):
// title, the initiative's lifecycle status, and — once a plan is ingested — the
// item-completion progress. Mirrors a task card's on-card "Start" affordance: the
// initiative's equivalent "Run planning" (and, while parked mid-interview, "Answer
// planning questions") lives right here on the board — the same actions the
// inspector offers — so starting an initiative isn't hidden behind selecting it.
// It likewise mirrors a task card's `attention` affordance: a planning run parked
// on the plan-approval gate (or on an agent-raised decision) offers the button that
// opens the window resolving it, instead of leaving the card on a spinning "Run
// planning" whose only route in was the inspector's execution panel.
// The tracker button opens the dedicated window directly.
//
// Laid out in a wrapping band above the frame's task swimlanes, not at coordinates. It used to be
// free-positioned inside the frame's canvas beside the task cards, and lost that along with them
// when tasks moved into lanes: with the canvas gone there is nothing left for an initiative's
// coordinates to be relative to, and its drag handle only ever moved it within a canvas nothing
// renders now. An initiative is still a first-class board block with its own inspector.
import type { InitiativeStatus } from '~/types/domain'
import { useInitiativePlanning } from '~/composables/useInitiativePlanning'
import {
  INITIATIVE_ATTENTION_ICONS,
  INITIATIVE_ATTENTION_LABEL_KEYS,
  INITIATIVE_STATUS_CHIPS,
  INITIATIVE_STATUS_LABEL_KEYS,
  initiativeProgress,
} from '~/utils/initiative'

const props = defineProps<{ blockId: string }>()
const board = useBoardStore()
const initiatives = useInitiativesStore()
const ui = useUiStore()
const { t } = useI18n()

const block = computed(() => board.getBlock(props.blockId))
const initiative = computed(() => initiatives.forBlock(props.blockId))

const status = computed<InitiativeStatus>(() => initiative.value?.status ?? 'planning')
const statusLabel = computed(() => t(INITIATIVE_STATUS_LABEL_KEYS[status.value]))

const progress = computed(() => initiativeProgress(initiative.value?.items))

const selected = computed(() => ui.selectedBlockId === props.blockId)

// The "Run planning" / "Answer planning questions" affordances, shared with the inspector so the
// board card and inspector can't drift (see {@link useInitiativePlanning}).
const {
  planningPipeline,
  running,
  awaitingAnswers,
  interviewing,
  attention,
  starting,
  runPlanning,
  openPlanning,
  openTracker,
} = useInitiativePlanning(() => props.blockId)

function select() {
  ui.select(props.blockId)
}
</script>

<template>
  <div v-if="block" class="w-[230px]">
    <div
      data-testid="initiative-card"
      :data-status="status"
      class="cursor-pointer rounded-lg border border-indigo-800/60 bg-indigo-950/40 p-3 transition hover:border-indigo-600"
      :class="[
        selected ? 'ring-2 ring-indigo-400/60' : '',
        awaitingAnswers || attention ? 'board-pulse' : '',
      ]"
      @click.stop="select"
    >
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-milestone" class="h-4 w-4 shrink-0 text-indigo-400" />
          <div class="text-xs font-semibold text-white">{{ block.title }}</div>
        </div>
        <UBadge :color="INITIATIVE_STATUS_CHIPS[status]" variant="subtle" size="sm">
          {{ statusLabel }}
        </UBadge>
      </div>
      <div class="mt-1 text-[10px] uppercase tracking-wide text-indigo-300/70">
        {{ t('initiative.card.kind') }}
      </div>
      <div v-if="progress" class="mt-2 space-y-1">
        <div class="h-1.5 overflow-hidden rounded bg-slate-800">
          <div
            class="h-full rounded bg-indigo-400"
            :style="{ width: `${Math.round((progress.settled / progress.total) * 100)}%` }"
          />
        </div>
        <div class="text-[10px] text-slate-400">
          {{ t('initiative.card.progress', { done: progress.settled, total: progress.total }) }}
        </div>
      </div>
      <div class="nodrag mt-2 flex flex-wrap items-center gap-1">
        <!-- Parked for a human: the drafted plan awaits approval, or an agent raised a
             decision. Opens the window that can resolve the park (never the generic panel,
             which the server refuses for a park a dedicated window owns). -->
        <UButton
          v-if="attention"
          data-testid="initiative-card-review"
          :data-attention="attention.kind"
          size="xs"
          variant="solid"
          color="warning"
          :icon="INITIATIVE_ATTENTION_ICONS[attention.kind]"
          @click.stop="attention.open()"
        >
          {{ t(INITIATIVE_ATTENTION_LABEL_KEYS[attention.kind]) }}
        </UButton>
        <UButton
          v-else-if="awaitingAnswers"
          data-testid="initiative-card-answer-planning"
          size="xs"
          variant="solid"
          color="primary"
          icon="i-lucide-messages-square"
          @click.stop="openPlanning"
        >
          {{ t('initiative.inspector.answerPlanning') }}
        </UButton>
        <!-- Mid-pass: nothing to answer, but keep the route into the window (it shows the wait). -->
        <UButton
          v-else-if="interviewing"
          data-testid="initiative-card-planning-in-progress"
          size="xs"
          variant="soft"
          color="neutral"
          icon="i-lucide-loader-circle"
          :ui="{ leadingIcon: 'animate-spin' }"
          @click.stop="openPlanning"
        >
          {{ t('initiative.inspector.planningInProgress') }}
        </UButton>
        <UButton
          v-else
          data-testid="initiative-card-run-planning"
          size="xs"
          variant="soft"
          color="primary"
          icon="i-lucide-play"
          :loading="starting || running"
          :disabled="!planningPipeline || running || starting"
          :title="t('initiative.inspector.runPlanning')"
          @click.stop="runPlanning"
        >
          {{ t('initiative.inspector.runPlanning') }}
        </UButton>
        <UButton
          data-testid="initiative-open-tracker"
          size="xs"
          variant="soft"
          color="neutral"
          icon="i-lucide-list-checks"
          @click.stop="openTracker"
        >
          {{ t('initiative.card.openTracker') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
