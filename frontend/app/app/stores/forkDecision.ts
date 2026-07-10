import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ForkDecisionStepState } from '~/types/execution'
import { useApi } from '~/composables/useApi'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * The implementation-fork decision action surface. The live fork state lives on the run's
 * Coder step (`step.forkDecision`) and is kept fresh by the execution stream, so the window
 * reads it straight off the execution store — this store only wraps the `choose` action (and
 * a warm-up `load`), tracks the in-flight state so the window can disable its controls, and
 * reflects the returned state back onto the execution store so the UI updates immediately even
 * before the stream echoes the change. Keyed by executionId, mirroring the follow-ups store.
 */
export const useForkDecisionStore = defineStore('forkDecision', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()

  /** True while a choose call is in flight (drives the Choose button spinner / disabled state). */
  const choosing = ref(false)
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  /** Reflect an authoritative fork-decision state onto the run's Coder step. */
  function reflect(executionId: string, state: ForkDecisionStepState | null): void {
    if (!state) return
    const instance = execution.getInstance(executionId)
    const step = instance?.steps.find((s) => s.forkDecision)
    if (step) step.forkDecision = state
  }

  /** Warm the live state from the GET (the stream also keeps it fresh). Best-effort. */
  async function load(executionId: string): Promise<void> {
    error.value = null
    try {
      const state = await api.getForkDecision(workspace.requireId(), executionId)
      reflect(executionId, state as ForkDecisionStepState | null)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load'
    }
  }

  /**
   * Choose an implementation approach: a proposed fork id OR a custom free-text approach
   * (with an optional steering note). The Coder then re-runs with the choice folded in.
   */
  async function choose(
    executionId: string,
    choice: { forkId?: string; custom?: string; note?: string },
  ): Promise<void> {
    error.value = null
    choosing.value = true
    try {
      const state = await api.chooseFork(workspace.requireId(), executionId, choice)
      reflect(executionId, state as ForkDecisionStepState)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to choose'
      throw e
    } finally {
      choosing.value = false
    }
  }

  return { choosing, error, load, choose }
})
