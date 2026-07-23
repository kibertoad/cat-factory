<script setup lang="ts">
// A small pre-warn badge shown next to an "Add task" affordance when the workspace's opt-in
// review-debt friction is at (or past) its threshold, so the friction dialog isn't a surprise.
// Hidden entirely when friction is off or the queue is under the warn threshold. The server
// remains the authority — this is a hint. See backend/docs/review-debt-friction.md.
import { computed } from 'vue'
import { useReviewDebt } from '~/composables/useReviewDebt'

const { active, debtCount, blocked } = useReviewDebt()
const { t } = useI18n()

const color = computed(() => (blocked.value ? 'error' : 'warning'))
</script>

<template>
  <UBadge
    v-if="active"
    :color="color"
    variant="subtle"
    size="sm"
    icon="i-lucide-clock"
    :title="t('errors.reviewFriction.badge', { count: debtCount })"
  >
    {{ debtCount }}
  </UBadge>
</template>
