<script setup lang="ts">
// How much effort a code review spends, picked from the shared five-level scale (low → max).
// The level moves the review's confidence floor, its findings cap, whether each finding is verified
// before it is reported, and how widely it fans out; the copy for each level lives under the
// `reviewEffort.*` i18n keys so the review-task form and the risk-policy editor word it the same.
import { REVIEW_EFFORT_LEVELS, type ReviewEffortLevel } from '@cat-factory/contracts'

const model = defineModel<ReviewEffortLevel>({ required: true })
const { t } = useI18n()

const items = computed(() =>
  REVIEW_EFFORT_LEVELS.map((level) => ({ value: level, label: t(`reviewEffort.levels.${level}`) })),
)
</script>

<template>
  <UFormField :label="t('reviewEffort.label')" :hint="t('reviewEffort.help')">
    <USelect v-model="model" :items="items" class="w-full" data-testid="review-effort-select" />
  </UFormField>
</template>
