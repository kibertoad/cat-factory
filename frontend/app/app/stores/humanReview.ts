import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useExecutionStore } from '~/stores/execution'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Human-review gate actions. The gate's live state rides on its execution step (`step.gate`) and
 * arrives via the execution stream, so this store holds NO gate state — it only drives the
 * freeform "request a fix" action and patches the execution store from the response. A per-block
 * `busy` flag lets the window disable its control while the request is in flight.
 */
export const useHumanReviewStore = defineStore('humanReview', () => {
  const api = useApi()
  const ws = useWorkspaceStore()
  const execution = useExecutionStore()

  const busy = ref<Set<string>>(new Set())

  function isBusy(blockId: string): boolean {
    return busy.value.has(blockId)
  }

  /** Dispatch the fixer against the PR from a human's freeform instructions (bypasses grace). */
  async function requestFix(blockId: string, instructions: string): Promise<void> {
    const next = new Set(busy.value)
    next.add(blockId)
    busy.value = next
    try {
      const instance = await api.requestHumanReviewFix(ws.requireId(), blockId, instructions)
      if (instance && typeof instance === 'object' && 'steps' in instance) {
        execution.upsert(instance as Parameters<typeof execution.upsert>[0])
      }
    } finally {
      const after = new Set(busy.value)
      after.delete(blockId)
      busy.value = after
    }
  }

  return { isBusy, requestFix }
})
