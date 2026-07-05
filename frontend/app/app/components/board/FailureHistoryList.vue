<script setup lang="ts">
// The newest-first list of failed-attempt entries (timestamp + message + hint + collapsible
// detail), shared by the task-inspector's "previous errors" disclosure (AgentFailureHistory)
// and the step-detail overlay's per-step "execution history". Presentational only — the caller
// decides which trail to pass (the whole run's, or one step's) and how to reveal it.
import type { AgentFailure } from '~/types/domain'
import FailureDetail from '~/components/board/FailureDetail.vue'

const props = defineProps<{ failures: AgentFailure[] }>()

const { d } = useI18n()

// Newest attempt first — the most recent failure is the most relevant to look at.
const ordered = computed(() => [...props.failures].reverse())
</script>

<template>
  <ol class="space-y-2">
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
</template>
