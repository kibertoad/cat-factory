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
  /**
   * True while the warm-up read is in flight. The window renders no state until it settles, and
   * "still fetching" must not render as the "nothing to choose between" empty state: on this
   * surface that empty state is a claim the run generated nothing to compare.
   */
  const loading = ref(false)
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

  /**
   * Warm the live state from the GET (the stream also keeps it fresh). The failure is RECORDED
   * rather than swallowed: with no state on the step, a failed read and a run that produced no
   * candidates are the same `null` and opposite facts, and only one of them is worth a Retry.
   */
  async function load(executionId: string): Promise<void> {
    error.value = null
    loading.value = true
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
    } finally {
      loading.value = false
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

  return { keeping, loading, error, load, keep }
})
