<script setup lang="ts">
// Which severities the latest reviewer pass raised, why, and what it left out. A review held to
// `high` that comes back with two findings must not read like a review that found only two
// problems, and a progressive policy that fell back for want of an estimate must say so.
import { computed } from 'vue'
import type { RequirementFindingFloorRecord } from '@cat-factory/contracts'

const props = defineProps<{ floor: RequirementFindingFloorRecord | null | undefined }>()

const { t } = useI18n()

const raised = computed(() => {
  if (!props.floor) return null
  switch (props.floor.severity) {
    case 'high':
      return t('requirements.findingFloor.raised.high')
    case 'medium':
      return t('requirements.findingFloor.raised.medium')
    case 'low':
      return t('requirements.findingFloor.raised.low')
  }
  return null
})

const basis = computed(() => {
  if (!props.floor) return null
  switch (props.floor.basis) {
    case 'fixed':
      return t('requirements.findingFloor.basis.fixed')
    case 'estimate':
      return t('requirements.findingFloor.basis.estimate', {
        score: Math.round((props.floor.score ?? 0) * 100),
      })
    case 'no_estimate':
      return t('requirements.findingFloor.basis.no_estimate')
  }
  return null
})
</script>

<template>
  <p
    v-if="floor && raised"
    class="mb-4 text-xs text-dimmed"
    data-testid="requirements-finding-floor"
  >
    {{ raised }} {{ basis }}
    <template v-if="floor.suppressed > 0">
      {{ t('requirements.findingFloor.suppressed', { count: floor.suppressed }) }}
    </template>
    <template v-if="(floor.followUpSuppressed ?? 0) > 0">
      {{ t('requirements.findingFloor.followUpSuppressed', { count: floor.followUpSuppressed }) }}
    </template>
  </p>
</template>
