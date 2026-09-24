<script setup lang="ts">
// The step-detail overlay's per-step "execution history": a newest-first, MERGED timeline of
// this step's SUCCESSFUL prior outputs (discarded by a restart) and its FAILED attempts — so
// the history surfaces what superseded attempts PRODUCED, not only the errors. Presentational
// only: the caller passes both trails already narrowed to the step (by `stepIndex`).
import type { AgentFailure, PriorStepOutput } from '~/types/domain'
import FailureDetail from '~/components/board/FailureDetail.vue'
import CopyButton from '~/components/common/CopyButton.vue'

const props = defineProps<{ failures: AgentFailure[]; outputs: PriorStepOutput[] }>()

const { t, d } = useI18n()

type Entry =
  | { kind: 'failure'; key: string; occurredAt: number; failure: AgentFailure }
  | { kind: 'success'; key: string; occurredAt: number; output: PriorStepOutput }

// Merge both trails and show newest first — the most recent attempt is the most relevant.
// Each entry's `key` is its position within its OWN trail (both are append-only, so that
// position is a stable identity), not the volatile merged-sort index — and it stays unique
// even when several entries share a timestamp (a restart can discard many steps with the same
// clock-fallback `occurredAt`).
const entries = computed<Entry[]>(() =>
  [
    ...props.failures.map((failure, i): Entry => ({
      kind: 'failure',
      key: `failure-${i}`,
      occurredAt: failure.occurredAt,
      failure,
    })),
    ...props.outputs.map((output, i): Entry => ({
      kind: 'success',
      key: `success-${i}`,
      occurredAt: output.occurredAt,
      output,
    })),
  ].sort((a, b) => b.occurredAt - a.occurredAt),
)
</script>

<template>
  <ol class="space-y-2">
    <li
      v-for="entry in entries"
      :key="entry.key"
      class="rounded-md border px-2.5 py-2"
      :class="
        entry.kind === 'success'
          ? 'border-app-success-900/60 bg-app-success-950/20'
          : 'border-default/80 bg-app-950/50'
      "
      :data-testid="
        entry.kind === 'success' ? 'step-history-success-entry' : 'step-history-failure-entry'
      "
    >
      <!-- a superseded SUCCESSFUL attempt: its output, collapsible + copyable -->
      <template v-if="entry.kind === 'success'">
        <div class="flex items-center gap-1.5 text-3xs text-dimmed">
          <UIcon name="i-lucide-check-circle-2" class="h-3 w-3 shrink-0 text-app-success-400/70" />
          <time>{{ d(new Date(entry.occurredAt), 'long') }}</time>
          <span class="text-app-success-400/80">{{ t('panels.stepDetail.attemptSucceeded') }}</span>
        </div>
        <div class="relative mt-1">
          <CopyButton :text="entry.output.output" class="absolute end-1 top-1 z-10" />
          <pre
            class="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-app-950/80 p-1.5 pe-9 text-3xs leading-snug text-toned"
            >{{ entry.output.output }}</pre>
        </div>
        <p v-if="entry.output.truncated" class="mt-1 text-3xs text-dimmed">
          {{ t('panels.stepDetail.outputTruncated') }}
        </p>
      </template>

      <!-- a FAILED attempt: mirrors FailureHistoryList's entry markup -->
      <template v-else>
        <div class="flex items-center gap-1.5 text-3xs text-dimmed">
          <UIcon name="i-lucide-alert-triangle" class="h-3 w-3 shrink-0 text-app-error-400/70" />
          <time>{{ d(new Date(entry.occurredAt), 'long') }}</time>
        </div>
        <p class="mt-1 text-2xs leading-snug text-toned" :title="entry.failure.message">
          {{ entry.failure.message }}
        </p>
        <p v-if="entry.failure.hint" class="mt-1 text-3xs leading-snug text-dimmed">
          {{ entry.failure.hint }}
        </p>
        <FailureDetail
          :detail="entry.failure.detail"
          :message="entry.failure.message"
          summary-class="text-3xs text-dimmed hover:text-toned"
          pre-class="bg-app-950/80 text-3xs text-muted"
        />
      </template>
    </li>
  </ol>
</template>
