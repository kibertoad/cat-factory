<script setup lang="ts">
// Inspector body for an `initiative`-level block: the entity's status + goal, the
// "Run planning" control (pinned to the Initiative Planning pipeline — the engine
// refuses any other on this block), the execution-loop controls (pause / resume /
// cancel once executing), and the tracker window opener. Plan/policy editing lands
// with slice 4.
import type { Block, InitiativeStatus } from '~/types/domain'
import { useInitiativePlanning } from '~/composables/useInitiativePlanning'
import { INITIATIVE_STATUS_LABEL_KEYS, initiativeProgress } from '~/utils/initiative'

const props = defineProps<{ block: Block }>()

const initiatives = useInitiativesStore()
const { t } = useI18n()

const initiative = computed(() => initiatives.forBlock(props.block.id))

const status = computed<InitiativeStatus>(() => initiative.value?.status ?? 'planning')

// The "Run planning" / "Answer planning questions" affordances, shared with the board card so the
// two surfaces can't drift (see {@link useInitiativePlanning}).
const {
  planningPipeline,
  running,
  awaitingAnswers,
  starting,
  runPlanning,
  openPlanning,
  openTracker,
} = useInitiativePlanning(() => props.block.id)

const progress = computed(() => initiativeProgress(initiative.value?.items))

// Execution-loop controls appear once planning is done (the loop owns the block).
const isExecuting = computed(() => status.value === 'executing')
const isPaused = computed(() => status.value === 'paused')
function control(action: 'pause' | 'resume' | 'cancel') {
  void initiatives.control(props.block.id, action)
}
</script>

<template>
  <div class="space-y-3" data-testid="initiative-inspector">
    <div class="flex items-center gap-2">
      <UBadge color="primary" variant="subtle" size="sm">
        {{ t(INITIATIVE_STATUS_LABEL_KEYS[status]) }}
      </UBadge>
      <span v-if="progress" class="text-[11px] text-slate-400">
        {{ t('initiative.card.progress', { done: progress.settled, total: progress.total }) }}
      </span>
    </div>

    <p v-if="initiative?.goal" class="whitespace-pre-wrap text-[12px] text-slate-300">
      {{ initiative.goal }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <UButton
        v-if="awaitingAnswers"
        data-testid="initiative-answer-planning"
        color="primary"
        variant="solid"
        size="sm"
        icon="i-lucide-messages-square"
        @click="openPlanning"
      >
        {{ t('initiative.inspector.answerPlanning') }}
      </UButton>
      <UButton
        data-testid="initiative-run-planning"
        color="primary"
        variant="soft"
        size="sm"
        icon="i-lucide-play"
        :loading="starting || running"
        :disabled="!planningPipeline || running || starting"
        @click="runPlanning"
      >
        {{ t('initiative.inspector.runPlanning') }}
      </UButton>
      <UButton
        data-testid="initiative-inspector-tracker"
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-lucide-list-checks"
        @click="openTracker"
      >
        {{ t('initiative.card.openTracker') }}
      </UButton>
    </div>

    <!-- Execution-loop controls (slice 3): pause / resume / cancel an executing initiative. -->
    <div v-if="isExecuting || isPaused" class="flex flex-wrap items-center gap-2">
      <UButton
        v-if="isExecuting"
        data-testid="initiative-pause"
        color="warning"
        variant="soft"
        size="sm"
        icon="i-lucide-pause"
        :loading="initiatives.controlling"
        @click="control('pause')"
      >
        {{ t('initiative.inspector.pause') }}
      </UButton>
      <UButton
        v-if="isPaused"
        data-testid="initiative-resume"
        color="primary"
        variant="soft"
        size="sm"
        icon="i-lucide-play"
        :loading="initiatives.controlling"
        @click="control('resume')"
      >
        {{ t('initiative.inspector.resume') }}
      </UButton>
      <UButton
        data-testid="initiative-cancel"
        color="error"
        variant="soft"
        size="sm"
        icon="i-lucide-square"
        :loading="initiatives.controlling"
        @click="control('cancel')"
      >
        {{ t('initiative.inspector.cancel') }}
      </UButton>
    </div>

    <p class="text-[11px] text-slate-500">
      {{ t('initiative.inspector.hint') }}
    </p>
  </div>
</template>
