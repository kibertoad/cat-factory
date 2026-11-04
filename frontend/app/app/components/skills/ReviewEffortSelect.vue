<script setup lang="ts">
// How much effort a code review spends, picked from the shared five-level scale (low → max).
// The level moves the review's confidence floor, its findings cap, whether each finding is verified
// before it is reported, and how widely it fans out. The level labels are shared with the
// risk-policy editor through `reviewEffortOptions`, so both pickers word them the same.
import type { ReviewEffortLevel } from '@cat-factory/contracts'
import { reviewEffortOptions } from '~/utils/reviewEffortLevel'

const model = defineModel<ReviewEffortLevel>({ required: true })
const { t } = useI18n()

const items = computed(() => reviewEffortOptions(t))
</script>

<template>
  <UFormField :label="t('reviewEffort.label')" :hint="t('reviewEffort.help')">
    <USelect v-model="model" :items="items" class="w-full" data-testid="review-effort-select" />
  </UFormField>
</template>
