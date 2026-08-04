import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ResolveInputGateChoice, RunInputGate } from '@cat-factory/contracts'
import { useApi } from '~/composables/useApi'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * The PRE-TOKEN INPUT GATE's action surface. The verdict itself lives on the run
 * (`instance.inputGate`) and is kept fresh by the execution stream, so this store only wraps the
 * `resolve` action, tracks the in-flight state so the notice can disable its buttons, and
 * reflects the returned verdict back so the UI updates before the stream echoes it.
 *
 * The echo goes through {@link ExecutionStore.echoAfter} rather than a bare assignment: a
 * successful resolve WAKES THE DURABLE DRIVER, whose next emit routinely beats this HTTP
 * response, so an unguarded write would put the released run back into `blocked` and, if the
 * run then parks on something else, leave it there with nothing left to emit.
 */
export const useInputGateStore = defineStore('inputGate', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()

  /** True while a resolve call is in flight (drives the buttons' spinner / disabled state). */
  const resolving = ref(false)
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  /**
   * Resolve the parked gate. `recheck` re-evaluates the task as it now stands and releases the
   * run only if the blocking gaps are genuinely gone. A still-blocked verdict comes back as an
   * ordinary 200 with refreshed findings rather than an error, because nothing went wrong: the
   * task is just not fixed yet. `proceed` waives the findings.
   */
  async function resolve(
    executionId: string,
    choice: ResolveInputGateChoice,
  ): Promise<RunInputGate | null> {
    error.value = null
    resolving.value = true
    try {
      return await execution.echoAfter(
        executionId,
        () => api.resolveInputGate(workspace.requireId(), executionId, { choice }),
        (gate, instance) => {
          instance.inputGate = gate as RunInputGate
        },
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to resolve'
      throw e
    } finally {
      resolving.value = false
    }
  }

  return { resolving, error, resolve }
})
