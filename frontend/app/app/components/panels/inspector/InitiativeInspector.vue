<script setup lang="ts">
// Inspector body for an `initiative`-level block: the entity's status + goal, the
// "Run planning" control (pinned to the Initiative Planning pipeline — the engine
// refuses any other on this block), and the tracker window opener. Read-only in
// this slice; plan/policy editing lands with the execution loop.
import type { Block, InitiativeStatus } from '~/types/domain'

const props = defineProps<{ block: Block }>()

const initiatives = useInitiativesStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const { t } = useI18n()

const initiative = computed(() => initiatives.forBlock(props.block.id))

const STATUS_LABEL_KEYS: Record<InitiativeStatus, string> = {
  planning: 'initiative.status.planning',
  awaiting_approval: 'initiative.status.awaiting_approval',
  executing: 'initiative.status.executing',
  paused: 'initiative.status.paused',
  done: 'initiative.status.done',
  cancelled: 'initiative.status.cancelled',
}
const status = computed<InitiativeStatus>(() => initiative.value?.status ?? 'planning')

// The ONLY pipeline runnable on an initiative block (see the engine's runnable guard).
const planningPipeline = computed(() => pipelines.pipelines.find((p) => p.id === 'pl_initiative'))
const running = computed(() => !!props.block.executionId)

function runPlanning() {
  if (planningPipeline.value) void execution.start(props.block.id, planningPipeline.value)
}
function openTracker() {
  ui.openInitiativeTracker(props.block.id)
}

const progress = computed(() => {
  const items = initiative.value?.items ?? []
  if (items.length === 0) return null
  const settled = items.filter((i) => i.status === 'done' || i.status === 'skipped').length
  return { settled, total: items.length }
})
</script>

<template>
  <div class="space-y-3" data-testid="initiative-inspector">
    <div class="flex items-center gap-2">
      <UBadge color="primary" variant="subtle" size="sm">
        {{ t(STATUS_LABEL_KEYS[status]) }}
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
        data-testid="initiative-run-planning"
        color="primary"
        variant="soft"
        size="sm"
        icon="i-lucide-play"
        :disabled="!planningPipeline || running"
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

    <p class="text-[11px] text-slate-500">
      {{ t('initiative.inspector.hint') }}
    </p>
  </div>
</template>
