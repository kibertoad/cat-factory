<script setup lang="ts">
// How verbose a requirements review is under one risk policy: the lowest severity the reviewer
// raises, and optionally the task-estimate bands that move it. The fixed floor stays editable while
// the progression is on, because it is what applies to a task nobody has estimated.
import { computed } from 'vue'
import type { ReviewItemSeverity } from '@cat-factory/contracts'
import { FINDING_FLOOR_LABEL_KEYS, FINDING_FLOORS } from '~/utils/riskPolicyDraft'
import SectionLabel from '~/components/common/SectionLabel.vue'

defineProps<{ disabled?: boolean }>()

const floor = defineModel<ReviewItemSeverity>('floor', { required: true })
const progressive = defineModel<boolean>('progressive', { required: true })
const mediumFrom = defineModel<number>('mediumFrom', { required: true })
const lowFrom = defineModel<number>('lowFrom', { required: true })

const { t } = useI18n()

const floorOptions = computed<{ value: ReviewItemSeverity; label: string }[]>(() =>
  FINDING_FLOORS.map((value) => ({ value, label: t(FINDING_FLOOR_LABEL_KEYS[value]) })),
)

const inPercentRange = (n: unknown): boolean =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100
const bandsOutOfRange = computed(
  () => progressive.value && !(inPercentRange(mediumFrom.value) && inPercentRange(lowFrom.value)),
)
const bandsCrossed = computed(
  () => progressive.value && !bandsOutOfRange.value && mediumFrom.value > lowFrom.value,
)
</script>

<template>
  <div data-testid="risk-policy-finding-floor">
    <label class="block">
      <SectionLabel as="span" class="mb-1 block">
        {{
          progressive
            ? t('settings.riskPolicy.findingFloor.fallbackLabel')
            : t('settings.riskPolicy.findingFloor.label')
        }}
      </SectionLabel>
      <USelect
        v-model="floor"
        class="w-full sm:w-72"
        :items="floorOptions"
        value-key="value"
        size="sm"
        :disabled="disabled"
      />
      <span class="mt-1 block text-2xs text-dimmed">
        {{ t('settings.riskPolicy.findingFloor.hint') }}
      </span>
    </label>
    <USwitch
      v-model="progressive"
      class="mt-3"
      size="sm"
      :disabled="disabled"
      :label="t('settings.riskPolicy.findingFloor.progressiveLabel')"
      :description="t('settings.riskPolicy.findingFloor.progressiveHint')"
    />
    <div v-if="progressive" class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label class="block">
        <SectionLabel as="span" class="mb-1 block">
          {{ t('settings.riskPolicy.findingFloor.mediumFrom') }}
        </SectionLabel>
        <UInput
          v-model.number="mediumFrom"
          type="number"
          :min="0"
          :max="100"
          size="sm"
          :disabled="disabled"
        />
      </label>
      <label class="block">
        <SectionLabel as="span" class="mb-1 block">
          {{ t('settings.riskPolicy.findingFloor.lowFrom') }}
        </SectionLabel>
        <UInput
          v-model.number="lowFrom"
          type="number"
          :min="0"
          :max="100"
          size="sm"
          :disabled="disabled"
        />
      </label>
      <p v-if="bandsOutOfRange" class="text-2xs text-error sm:col-span-2" role="alert">
        {{ t('settings.riskPolicy.findingFloor.bandsOutOfRange') }}
      </p>
      <p v-else-if="bandsCrossed" class="text-2xs text-error sm:col-span-2" role="alert">
        {{ t('settings.riskPolicy.findingFloor.bandsCrossed') }}
      </p>
    </div>
  </div>
</template>
