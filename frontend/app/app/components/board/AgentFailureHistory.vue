<script setup lang="ts">
// The error trail of a run's PRIOR attempts, preserved across retries/restarts. This is
// deliberately SEPARATE from the top failure banner (`AgentFailureCard`, keyed on the
// current `status === 'failed'`): when a failed task is retried it restarts and the top
// banner disappears, but this collapsed history stays available so every previous error
// remains viewable. Renders nothing when there is no trail.
import type { AgentFailure } from '~/types/domain'
import FailureHistoryList from '~/components/board/FailureHistoryList.vue'

const props = defineProps<{ failures: AgentFailure[] }>()

const { t } = useI18n()
</script>

<template>
  <UCollapsible
    v-if="failures.length"
    class="nodrag rounded-lg border border-muted/60 bg-default/40 px-3 py-2"
    data-testid="agent-failure-history"
  >
    <template #default="{ open }">
      <UButton
        variant="link"
        color="neutral"
        size="xs"
        icon="i-lucide-history"
        :trailing-icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        :label="
          t('board.failure.history.previousErrors', { count: failures.length }, failures.length)
        "
        :ui="{ base: 'w-full justify-start gap-1.5 p-0 text-2xs text-muted hover:text-default' }"
      />
    </template>

    <template #content>
      <FailureHistoryList :failures="props.failures" class="mt-2" />
    </template>
  </UCollapsible>
</template>
