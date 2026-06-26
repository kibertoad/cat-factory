import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * The Follow-up companion action surface. The live item state lives on the run's Coder step
 * (`step.followUps`) and is kept fresh by the execution stream, so the window reads items
 * straight off the execution store — this store only wraps the decide actions (file / send
 * back / answer / dismiss) and tracks which item is mid-action so the window can disable its
 * buttons. The returned state is also pushed back into the execution store so the UI updates
 * immediately even before the stream echoes the change.
 */
export const useFollowUpsStore = defineStore('followUps', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()

  /** Item ids with an action in flight (drives per-row spinners / disabled buttons). */
  const acting = ref<Set<string>>(new Set())
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  function isActing(itemId: string): boolean {
    return acting.value.has(itemId)
  }

  function mark(itemId: string, on: boolean) {
    const next = new Set(acting.value)
    if (on) next.add(itemId)
    else next.delete(itemId)
    acting.value = next
  }

  /** Run one decide action, reflecting the returned state onto the run's Coder step. */
  async function act(
    executionId: string,
    itemId: string,
    call: (ws: string) => Promise<unknown>,
  ): Promise<void> {
    error.value = null
    mark(itemId, true)
    try {
      const state = await call(workspace.requireId())
      // Reflect the authoritative state immediately (the stream will also echo it).
      const instance = execution.getInstance(executionId)
      const step = instance?.steps.find((s) => s.followUps?.enabled)
      if (step && state && typeof state === 'object') {
        step.followUps = state as typeof step.followUps
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Action failed'
      throw e
    } finally {
      mark(itemId, false)
    }
  }

  const fileItem = (executionId: string, itemId: string) =>
    act(executionId, itemId, (ws) => api.fileFollowUp(ws, executionId, itemId))

  const queueItem = (executionId: string, itemId: string) =>
    act(executionId, itemId, (ws) => api.queueFollowUp(ws, executionId, itemId))

  const answerItem = (executionId: string, itemId: string, answer: string) =>
    act(executionId, itemId, (ws) => api.answerFollowUp(ws, executionId, itemId, answer))

  const dismissItem = (executionId: string, itemId: string) =>
    act(executionId, itemId, (ws) => api.dismissFollowUp(ws, executionId, itemId))

  return { acting, error, isActing, fileItem, queueItem, answerItem, dismissItem }
})
