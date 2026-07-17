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
  { size: 'xs', variant: 'soft' },
)

const { t } = useI18n()
const agentRuns = useAgentRunsStore()
const access = useWorkspaceAccess()
const toast = useToast()
const { confirm } = useConfirm()
const stopping = ref(false)

const displayLabel = computed(() => props.label ?? t('board.stop.label'))

async function stop() {
  if (stopping.value) return
  // Killing a running container discards its in-flight work — gate it behind a confirm,
  // matching the confirm-then-mutate contract the task reset path uses.
  const ok = await confirm({
    title: t('board.stop.confirm.title'),
    description: t('board.stop.confirm.body'),
    confirmLabel: t('board.stop.confirm.confirm'),
    variant: 'destructive',
    icon: 'i-lucide-circle-stop',
  })
  if (!ok) return
  stopping.value = true
  try {
    const kind = await agentRuns.stop(props.runId)
    toast.add({
      title: kind === 'bootstrap' ? t('board.stop.bootstrapStopped') : t('board.stop.runStopped'),
      description: t('board.stop.stoppedDescription'),
      icon: 'i-lucide-circle-stop',
      color: 'warning',
    })
  } catch (e) {
    toast.add({
      title: t('board.stop.stopFailed'),
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
    :disabled="!access.canExecuteRuns.value"
    :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
    @click.stop="stop"
  >
    {{ displayLabel }}
  </UButton>
</template>
