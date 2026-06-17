<script setup lang="ts">
// Self-contained "Stop" control for a RUNNING agent run (bootstrap or execution).
// Calls the unified stop through the agentRuns store — which kills the per-run
// container and tears down the durable driver server-side — then toasts the
// outcome so the user is told it actually happened. Mirrors AgentFailureCard's
// self-contained pattern so every surface (board card, inspector, task panel)
// behaves identically from one place.
import type { AgentRunKind } from '~/types/domain'

const props = withDefaults(
  defineProps<{
    runId: string
    /** Hint for the button label only; the backend resolves the real kind. */
    kind?: AgentRunKind
    size?: 'xs' | 'sm' | 'md'
    variant?: 'solid' | 'soft' | 'ghost' | 'subtle' | 'outline'
    label?: string
  }>(),
  { size: 'xs', variant: 'soft', label: 'Stop' },
)

const agentRuns = useAgentRunsStore()
const toast = useToast()
const stopping = ref(false)

async function stop() {
  if (stopping.value) return
  stopping.value = true
  try {
    const kind = await agentRuns.stop(props.runId)
    toast.add({
      title: kind === 'bootstrap' ? 'Bootstrap stopped' : 'Run stopped',
      description: 'The container was killed and the run was cancelled.',
      icon: 'i-lucide-circle-stop',
      color: 'warning',
    })
  } catch (e) {
    toast.add({
      title: 'Stop failed',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    stopping.value = false
  }
}
</script>

<template>
  <UButton
    class="nodrag"
    color="warning"
    :variant="variant"
    :size="size"
    icon="i-lucide-circle-stop"
    :loading="stopping"
    @click.stop="stop"
  >
    {{ label }}
  </UButton>
</template>
