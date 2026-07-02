<script setup lang="ts">
// The error trail of a run's PRIOR attempts, preserved across retries/restarts. This is
// deliberately SEPARATE from the top failure banner (`AgentFailureCard`, keyed on the
// current `status === 'failed'`): when a failed task is retried it restarts and the top
// banner disappears, but this collapsed history stays available so every previous error
// remains viewable. Renders nothing when there is no trail.
import type { AgentFailure } from '~/types/domain'
import FailureDetail from '~/components/board/FailureDetail.vue'

const props = defineProps<{ failures: AgentFailure[] }>()

const { t, d } = useI18n()

// Newest attempt first — the most recent failure is the most relevant to look at.
const ordered = computed(() => [...props.failures].reverse())
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

    <ol class="mt-2 space-y-2">
      <li
        v-for="failure in ordered"
        :key="failure.occurredAt"
        class="rounded-md border border-slate-800/80 bg-slate-950/50 px-2.5 py-2"
        data-testid="agent-failure-history-entry"
      >
        <div class="flex items-center gap-1.5 text-[10px] text-slate-500">
          <UIcon name="i-lucide-alert-triangle" class="h-3 w-3 shrink-0 text-rose-400/70" />
          <time>{{ d(new Date(failure.occurredAt), 'long') }}</time>
        </div>

        <p class="mt-1 text-[11px] leading-snug text-slate-300" :title="failure.message">
          {{ failure.message }}
        </p>

        <p v-if="failure.hint" class="mt-1 text-[10px] leading-snug text-slate-500">
          {{ failure.hint }}
        </p>

        <FailureDetail
          :detail="failure.detail"
          :message="failure.message"
          summary-class="text-[10px] text-slate-500 hover:text-slate-300"
          pre-class="bg-slate-950/80 text-[10px] text-slate-400"
        />
      </li>
    </ol>
  </details>
</template>
