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
    /** The estimate or a run condition may skip this step, so a new checkpoint here is refused. */
    unreachableProducer?: boolean
    unreachableCompanion?: boolean
  }>(),
  {
    companionLabel: '',
    lockedProducer: false,
    lockedCompanion: false,
    unreachableProducer: false,
    unreachableCompanion: false,
  },
)

const emit = defineEmits<{ update: [gates: { producer: boolean; companion: boolean }] }>()

const { t } = useI18n()

const placement = computed(() =>
  checkpointPlacement(props.producerGated, props.companionGated === true),
)
const gated = computed(() => placement.value !== 'none')

/**
 * A placement is not offered when it would switch off a checkpoint the built-in ships, or add one
 * the run could skip past. A checkpoint already on stays selectable, so a stored one can be kept.
 */
function allowed(candidate: CheckpointPlacement): boolean {
  const gates = placementGates(candidate)
  if (props.lockedProducer && !gates.producer) return false
  if (props.lockedCompanion && !gates.companion) return false
  if (props.unreachableProducer && gates.producer && !props.producerGated) return false
  return !(props.unreachableCompanion && gates.companion && props.companionGated !== true)
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
const unreachable = computed(
  () => props.unreachableProducer && !props.producerGated && props.companionGated === null,
)

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
    :disabled="locked || unreachable"
    :label="
      locked
        ? t('pipeline.checkpoint.locked')
        : unreachable
          ? t('pipeline.checkpoint.unreachable')
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
