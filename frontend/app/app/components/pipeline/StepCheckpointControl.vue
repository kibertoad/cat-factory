<script setup lang="ts">
// Where one builder row pauses for a person: the human approval gate of a step, or of a step and
// the companion folded into its row.
//
// A plain step gets a toggle. A producer with its companion gets a choice of FOUR, because the two
// are separate steps whose gates mean different things: the producer's pauses on every draft,
// including each rework round the companion sends back, and the companion's pauses once, on the
// draft it passed. A single toggle on the row could only ever gate the producer, and never said so.
//
// Value-driven (state in, `update` out) so the builder's draft and the built-in approvals dialog
// bind it to their own state. `locked` marks a checkpoint the built-in's catalog ships: shown on,
// and not offered for removal, because only a clone may drop one.
import { computed } from 'vue'
import IconButton from '~/components/common/IconButton.vue'
import {
  CHECKPOINT_PLACEMENTS,
  checkpointPlacement,
  placementGates,
  type CheckpointPlacement,
} from '~/utils/pipelineCheckpoints'

const props = withDefaults(
  defineProps<{
    producerGated: boolean
    /** The companion's gate, or null when the row has no companion. */
    companionGated: boolean | null
    producerLabel: string
    companionLabel?: string
    lockedProducer?: boolean
    lockedCompanion?: boolean
  }>(),
  { companionLabel: '', lockedProducer: false, lockedCompanion: false },
)

const emit = defineEmits<{ update: [gates: { producer: boolean; companion: boolean }] }>()

const { t } = useI18n()

const placement = computed(() =>
  checkpointPlacement(props.producerGated, props.companionGated === true),
)
const gated = computed(() => placement.value !== 'none')

/** A placement that would switch off a checkpoint the built-in ships is not offered. */
function allowed(candidate: CheckpointPlacement): boolean {
  const gates = placementGates(candidate)
  return (!props.lockedProducer || gates.producer) && (!props.lockedCompanion || gates.companion)
}

const names = computed(() => ({ producer: props.producerLabel, companion: props.companionLabel }))

const items = computed(() =>
  CHECKPOINT_PLACEMENTS.map((candidate) => ({
    label: t(`pipeline.checkpoint.placement.${candidate}`, names.value),
    icon: placement.value === candidate ? 'i-lucide-check' : undefined,
    disabled: !allowed(candidate),
    onSelect: () => emit('update', placementGates(candidate)),
  })),
)

const summary = computed(() => t(`pipeline.checkpoint.summary.${placement.value}`, names.value))

const locked = computed(() => props.lockedProducer && props.companionGated === null)

function toggle() {
  emit('update', { producer: !props.producerGated, companion: false })
}
</script>

<template>
  <IconButton
    v-if="companionGated === null"
    :icon="gated ? 'i-lucide-shield-check' : 'i-lucide-shield'"
    :color="gated ? 'warning' : 'neutral'"
    variant="ghost"
    size="xs"
    :disabled="locked"
    :label="
      locked
        ? t('pipeline.checkpoint.locked')
        : gated
          ? t('pipeline.builder.approvalRemoveTooltip')
          : t('pipeline.builder.approvalAddTooltip')
    "
    data-testid="pipeline-step-gate"
    @click="toggle"
  />
  <UDropdownMenu v-else :items="[items]">
    <UButton
      :icon="gated ? 'i-lucide-shield-check' : 'i-lucide-shield'"
      :color="gated ? 'warning' : 'neutral'"
      variant="ghost"
      size="xs"
      :aria-label="summary"
      :data-placement="placement"
      data-testid="pipeline-step-gate"
    />
  </UDropdownMenu>
</template>
