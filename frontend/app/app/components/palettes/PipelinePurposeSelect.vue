<script setup lang="ts">
// The pipeline-PURPOSE control: what the pipeline being built exists to do (build, document,
// review, research, plan). It sits beside `AgentTierSelect` at the top of the agent palette
// because the two are the same kind of dial (each narrows the catalog below to what is worth
// offering), and a filter the user cannot see is a catalog that looks incomplete for no reason.
//
// Unlike the tier, this is not a view preference: it is saved on the pipeline and also decides
// which task pickers offer it (`pipelineAllowedForTaskType`). So the control writes through to
// the draft rather than to a store of its own.
import { computed } from 'vue'
import { isPipelinePurpose, PIPELINE_PURPOSES, type PipelinePurpose } from '@cat-factory/contracts'

const { t } = useI18n()

const props = defineProps<{
  /** The draft's purpose. Required: every pipeline carries one, the builder's default being `build`. */
  purpose: PipelinePurpose
  /** How many agent kinds the current purpose hides. Renders the "n hidden" hint when > 0. */
  hiddenCount?: number
}>()

const emit = defineEmits<{ (e: 'update:purpose', purpose: PipelinePurpose): void }>()

// One STATIC literal `t()` key per purpose (not a key assembled from the loop variable), so the
// typed-message-keys check covers them, the same shape `AgentTierSelect` uses for its tiers.
const PURPOSE_LABELS = computed<Record<PipelinePurpose, string>>(() => ({
  build: t('pipeline.builder.purposeOption.build'),
  document: t('pipeline.builder.purposeOption.document'),
  review: t('pipeline.builder.purposeOption.review'),
  research: t('pipeline.builder.purposeOption.research'),
  planning: t('pipeline.builder.purposeOption.planning'),
}))

// The button text. A stored purpose this build has no label for is NAMED as unrecognised and
// quoted back, rather than left to render as an empty string after the colon: it is the one state
// the user cannot diagnose from the control, because a purpose this bundle cannot name narrows
// nothing (see `purposeSuggestsAgentCategory`), so a blank label would read as a pipeline nobody
// classified while the saved row says otherwise. The menu still lists every member this build has,
// so naming the value is also the way out of it. Reachable even though the field is mandatory: the
// value is persisted and this bundle can be older than the member it reads.
const current = computed(() => {
  const purpose = props.purpose
  if (!isPipelinePurpose(purpose)) return t('pipeline.builder.purposeUnrecognized', { purpose })
  return PURPOSE_LABELS.value[purpose]
})

const items = computed(() => [
  PIPELINE_PURPOSES.map((purpose) => ({
    label: PURPOSE_LABELS.value[purpose],
    icon: purpose === props.purpose ? 'i-lucide-check' : 'i-lucide-target',
    onSelect: () => emit('update:purpose', purpose),
  })),
])
</script>

<template>
  <div class="space-y-1">
    <UDropdownMenu :items="items" :ui="{ content: 'z-[60] max-w-72' }">
      <UButton
        size="xs"
        color="neutral"
        variant="soft"
        icon="i-lucide-target"
        trailing-icon="i-lucide-chevron-down"
        class="w-full justify-between"
        :title="t('pipeline.builder.purposeLabel')"
        data-testid="pipeline-purpose-select"
      >
        <span class="truncate"> {{ t('pipeline.builder.purposeLabel') }}: {{ current }} </span>
      </UButton>
    </UDropdownMenu>
    <p v-if="props.hiddenCount" class="px-1 text-[10px] text-slate-500">
      {{ t('palette.purposeHidden', { count: props.hiddenCount }, props.hiddenCount) }}
    </p>
  </div>
</template>
