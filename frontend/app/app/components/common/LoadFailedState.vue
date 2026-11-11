<script setup lang="ts">
// The SPA's one "the read failed" render: the sibling of `EmptyState` for a list, panel or window
// whose load did not answer. A failed read must never render as `EmptyState` (that says "nothing
// here") or as the feature's "not enabled" notice (that is a 503 only), because each of the three
// needs a different action from the reader (AGENTS.md, "Degrade loudly").
//
// The title names what failed to load. A `retry` listener adds the retry button, so a surface with
// no way to re-read renders the state without a dead control. A caller that holds the classified
// failure passes it as `failure`, and `FailureMessage` shows its description, with the raw detail
// and the request id one click away.
//
// While a retry runs, a surface either swaps this state for its own loading skeleton (as on the
// first load) or, where it has none, keeps the state and passes `retrying`.
import EmptyState from '~/components/common/EmptyState.vue'
import FailureMessage from '~/components/common/FailureMessage.vue'
import type { DescribedFailure } from '~/composables/pipelineErrorToast/describeFailure'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    /** The classified failure, when the caller holds one: its description and detail render. */
    failure?: DescribedFailure | null
    compact?: boolean
    /** True while the retry is in flight, so the button shows it. */
    retrying?: boolean
    /** Set by the `@retry` listener; Vue exposes a declared `onX` emit listener as a prop. */
    onRetry?: () => void
  }>(),
  {
    description: undefined,
    failure: null,
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
    :title="props.title"
    :description="props.description"
    :compact="props.compact"
    data-testid="load-failed-state"
  >
    <div class="flex flex-col items-center gap-2">
      <FailureMessage v-if="props.failure" :failure="props.failure" class="text-xs text-muted" />
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
    </div>
  </EmptyState>
</template>
