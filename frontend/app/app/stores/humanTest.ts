import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useExecutionStore } from '~/stores/execution'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Human-testing gate actions. The gate's live state rides on its execution step
 * (`step.humanTest`) and arrives via the execution stream, so this store holds NO gate
 * state — it only drives the actions (confirm / request a fix / pull main / recreate /
 * destroy) and patches the execution store from each response. A per-block `busy` flag lets
 * the window disable its controls while an action is in flight. Per-workspace; nothing
 * persisted client-side.
 */
export const useHumanTestStore = defineStore('humanTest', () => {
  const api = useApi()
  const ws = useWorkspaceStore()
  const execution = useExecutionStore()

  /** Block ids with an action currently in flight (the window disables its buttons). */
  const busy = ref<Set<string>>(new Set())

  function isBusy(blockId: string): boolean {
    return busy.value.has(blockId)
  }

  async function run(blockId: string, action: () => Promise<unknown>): Promise<void> {
    const next = new Set(busy.value)
    next.add(blockId)
    busy.value = next
    try {
      const instance = await action()
      // The action returns the updated run; patch the store so the window reflects it
      // immediately (the stream also pushes it, but this avoids a flash of stale state).
      if (instance && typeof instance === 'object' && 'steps' in instance) {
        execution.upsert(instance as Parameters<typeof execution.upsert>[0])
      }
    } finally {
      const after = new Set(busy.value)
      after.delete(blockId)
      busy.value = after
    }
  }

  /** Confirm the change works: tear the env down and advance the pipeline. */
  function confirm(blockId: string): Promise<void> {
    return run(blockId, () => api.confirmHumanTest(ws.requireId(), blockId))
  }

  /** Submit findings and request a fix. */
  function requestFix(blockId: string, findings: string): Promise<void> {
    return run(blockId, () => api.requestHumanTestFix(ws.requireId(), blockId, findings))
  }

  /** Pull latest main into the branch + redeploy. */
  function pullMain(blockId: string): Promise<void> {
    return run(blockId, () => api.pullMainHumanTest(ws.requireId(), blockId))
  }

  /** Rebuild the ephemeral environment. */
  function recreateEnv(blockId: string): Promise<void> {
    return run(blockId, () => api.recreateHumanTestEnv(ws.requireId(), blockId))
  }

  /** Destroy the ephemeral environment (the run stays parked). */
  function destroyEnv(blockId: string): Promise<void> {
    return run(blockId, () => api.destroyHumanTestEnv(ws.requireId(), blockId))
  }

  return { isBusy, confirm, requestFix, pullMain, recreateEnv, destroyEnv }
})
