<script setup lang="ts">
// The SPA's one "the read failed" render: the sibling of `EmptyState` for a list, panel or window
// whose load did not answer. A failed read must never render as `EmptyState` (that says "nothing
// here") or as the feature's "not enabled" notice (that is a 503 only), because each of the three
// needs a different action from the reader (AGENTS.md, "Degrade loudly").
//
// The default title is generic; a caller with a more exact one passes it. A `retry` listener adds
// the retry button, so a surface with no way to re-read renders the state without a dead control.
import EmptyState from '~/components/common/EmptyState.vue'

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    compact?: boolean
    /** True while the retry is in flight, so the button shows it. */
    retrying?: boolean
    /** Set by the `@retry` listener; Vue exposes a declared `onX` emit listener as a prop. */
    onRetry?: () => void
  }>(),
  {
    title: undefined,
    description: undefined,
    compact: false,
    retrying: false,
    onRetry: undefined,
  },
)

const { t } = useI18n()
</script>

<template>
  <EmptyState
    icon="i-lucide-triangle-alert"
    :title="props.title ?? t('common.loadFailed')"
    :description="props.description"
    :compact="props.compact"
    data-testid="load-failed-state"
  >
    <UButton
      v-if="props.onRetry"
      size="xs"
      variant="soft"
      icon="i-lucide-refresh-cw"
      :loading="props.retrying"
      data-testid="load-failed-retry"
      @click="props.onRetry()"
    >
      {{ t('common.retry') }}
    </UButton>
  </EmptyState>
</template>
