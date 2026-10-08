<script setup lang="ts">
// A failed overview or answer: the translated reason, with the raw cause behind a disclosure.
import type { GuidedReviewFailure } from '~/types/domain'
import { failureKey } from '~/components/guidedReview/GuidedReview.logic'

defineProps<{ failure: GuidedReviewFailure }>()
const { t } = useI18n()
const expanded = ref(false)
</script>

<template>
  <div
    class="space-y-1 rounded-md bg-elevated/60 p-2 text-sm text-toned"
    data-testid="guided-review-failure"
  >
    <p class="flex items-start gap-2">
      <UIcon name="i-lucide-circle-alert" class="mt-0.5 h-4 w-4 shrink-0 text-error" />
      <span>{{ t(failureKey(failure.reason)) }}</span>
    </p>
    <template v-if="failure.detail">
      <UButton
        size="xs"
        variant="link"
        :icon="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        data-testid="guided-review-failure-toggle"
        @click="expanded = !expanded"
      >
        {{ t('guidedReview.failure.detail') }}
      </UButton>
      <pre
        v-if="expanded"
        class="whitespace-pre-wrap break-words text-xs text-muted"
        data-testid="guided-review-failure-detail"
        >{{ failure.detail }}</pre>
    </template>
  </div>
</template>
