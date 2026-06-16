<script setup lang="ts">
// Shared failure banner + retry for any failed "agent run" (a bootstrap or a
// task execution). Self-contained: it owns the in-flight retry guard and calls
// the unified retry through the agentRuns store, so every surface (board card,
// inspector, task panel) gets identical behaviour from one place. Replaces the
// three hand-rolled bootstrap banners that used to duplicate this logic.
import type { AgentRunSummary } from '~/stores/agentRuns'

const props = withDefaults(
  defineProps<{ run: AgentRunSummary; variant?: 'compact' | 'expanded' }>(),
  { variant: 'expanded' },
)

const agentRuns = useAgentRunsStore()
const toast = useToast()

const compact = computed(() => props.variant === 'compact')
const failure = computed(() => props.run.failure)
const title = computed(() => (props.run.kind === 'bootstrap' ? 'Bootstrap failed' : 'Run failed'))
const retryLabel = computed(() =>
  props.run.kind === 'bootstrap' ? 'Retry bootstrap' : 'Retry run',
)

const retrying = ref(false)
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try {
    await agentRuns.retry(props.run.runId)
  } catch (e) {
    toast.add({
      title: 'Retry failed',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div
    class="nodrag rounded-lg border border-rose-900/60 bg-rose-950/40"
    :class="compact ? 'px-3 py-2' : 'px-3 py-2.5'"
  >
    <div class="flex items-center gap-1.5" :class="compact ? 'text-[11px]' : 'text-xs'">
      <UIcon
        name="i-lucide-alert-triangle"
        class="shrink-0 text-rose-400"
        :class="compact ? 'h-3.5 w-3.5' : 'h-4 w-4'"
      />
      <span class="text-rose-300">{{ title }}</span>
    </div>

    <p
      v-if="failure?.message"
      class="mt-1 leading-snug text-rose-300/90"
      :class="compact ? 'line-clamp-2 text-[10px]' : 'text-[11px]'"
      :title="failure.message"
    >
      {{ failure.message }}
    </p>

    <p
      v-if="failure?.hint"
      class="mt-1 leading-snug text-rose-400/70"
      :class="compact ? 'text-[10px]' : 'text-[11px]'"
    >
      {{ failure.hint }}
    </p>

    <details v-if="!compact && failure?.detail && failure.detail !== failure.message" class="mt-1">
      <summary class="cursor-pointer text-[10px] text-rose-400/60 hover:text-rose-300">
        Show detail
      </summary>
      <pre
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-rose-950/60 p-1.5 text-[10px] text-rose-200/80"
        >{{ failure.detail }}</pre
      >
    </details>

    <button
      type="button"
      class="nodrag mt-2 flex items-center gap-1 rounded-md bg-rose-900/40 text-rose-200 hover:bg-rose-900/70 disabled:opacity-60"
      :class="compact ? 'px-2 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'"
      :disabled="retrying"
      @click.stop="retry"
    >
      <UIcon
        :name="retrying ? 'i-lucide-loader-circle' : 'i-lucide-rotate-ccw'"
        :class="[compact ? 'h-3 w-3' : 'h-3.5 w-3.5', { 'animate-spin': retrying }]"
      />
      {{ retrying ? 'Retrying…' : compact ? 'Retry' : retryLabel }}
    </button>
  </div>
</template>
