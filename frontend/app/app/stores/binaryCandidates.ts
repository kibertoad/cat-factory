import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { KeepBinaryCandidatesInput } from '@cat-factory/contracts'
import type { BinaryCandidateStepState } from '~/types/execution'
import { useApi } from '~/composables/useApi'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * The generated-candidate action surface. The live state lives on the run's step
 * (`step.binaryCandidates`) and the execution stream keeps it fresh, so the window reads it
 * straight off the execution store; this store only wraps the `keep` action (plus a warm-up
 * `load`), tracks the in-flight state so the window can disable its controls, and echoes the
 * returned state back so the UI settles without waiting for the stream. Shaped exactly like the
 * fork-decision store, which is the same park one subject over.
 */
export const useBinaryCandidatesStore = defineStore('binaryCandidates', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()

  /** True while a keep call is in flight (drives the button spinner / disabled state). */
  const keeping = ref(false)
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  /**
   * Apply an authoritative candidate state to the run's step.
   *
   * A pipeline may carry more than one generating step, so target the step this decision is
   * ABOUT rather than the first that happens to hold candidate state: prefer the one still
   * awaiting a choice, then the current step, and only then any step carrying state. Without
   * that order a run whose earlier generator already settled would have its finished record
   * overwritten by the live one.
   *
   * Only ever called through {@link ExecutionStore.echoAfter}, which drops the echo when the
   * event stream already delivered a newer revision.
   */
  function assign(
    instance: ReturnType<typeof execution.getInstance> & object,
    state: BinaryCandidateStepState,
  ): void {
    const current = instance.steps[instance.currentStep]
    const step =
      instance.steps.find((s) => s.binaryCandidates?.status === 'awaiting_choice') ??
      (current?.binaryCandidates ? current : undefined) ??
      instance.steps.find((s) => s.binaryCandidates)
    if (step) step.binaryCandidates = state
  }

  /** Warm the live state from the GET (the stream also keeps it fresh). Best-effort. */
  async function load(executionId: string): Promise<void> {
    error.value = null
    try {
      await execution.echoAfter(
        executionId,
        () => api.getBinaryCandidates(workspace.requireId(), executionId),
        (state, instance) => {
          if (state) assign(instance, state as BinaryCandidateStepState)
        },
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load'
    }
  }

  /**
   * Keep the chosen candidates (each with the id it is to be stored under) and discard the rest.
   * The step then re-runs to deliver exactly what survived.
   */
  async function keep(executionId: string, input: KeepBinaryCandidatesInput): Promise<void> {
    error.value = null
    keeping.value = true
    try {
      await execution.echoAfter(
        executionId,
        () => api.keepBinaryCandidates(workspace.requireId(), executionId, input),
        (state, instance) => assign(instance, state as BinaryCandidateStepState),
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to keep candidates'
      throw e
    } finally {
      keeping.value = false
    }
  }

  return { keeping, error, load, keep }
})
