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
  <details
    v-if="failures.length"
    class="nodrag rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2"
    data-testid="agent-failure-history"
  >
    <summary
      class="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200"
    >
      <UIcon name="i-lucide-history" class="h-3.5 w-3.5 shrink-0" />
      {{ t('board.failure.history.previousErrors', { count: failures.length }, failures.length) }}
    </summary>

    <FailureHistoryList :failures="props.failures" class="mt-2" />
  </details>
</template>
