<script setup lang="ts">
// The newest-first list of failed-attempt entries (time, cause line, and the backend's text
// behind a Details toggle: see FailureListEntry) behind the task inspector's "previous errors"
// disclosure (AgentFailureHistory).
// Presentational only — the caller decides which trail to pass and how to reveal it. (The
// step-detail overlay's per-step "execution history" uses StepExecutionHistory instead, which
// merges these failures with the successful outputs a restart superseded.)
import type { AgentFailure } from '~/types/domain'
import FailureListEntry from '~/components/board/FailureListEntry.vue'

const props = defineProps<{ failures: AgentFailure[] }>()

// Newest attempt first — the most recent failure is the most relevant to look at.
const ordered = computed(() => [...props.failures].reverse())
</script>

<template>
  <ol class="space-y-2">
    <li
      v-for="failure in ordered"
      :key="failure.occurredAt"
      class="rounded-md border border-default/80 bg-app-950/50 px-2.5 py-2"
      data-testid="agent-failure-history-entry"
    >
      <FailureListEntry :failure="failure" />
    </li>
  </ol>
</template>
