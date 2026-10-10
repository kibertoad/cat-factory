import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { JudgeStepState } from '~/types/execution'
import { useApi } from '~/composables/useApi'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * The JUDGE action surface (the fourth step-taxonomy bucket). The live verdict lives on the
 * run's judge step (`step.judge`) and is kept fresh by the execution stream, so the window reads
 * it straight off the execution store — this store only wraps the `resolve` action (and a
 * warm-up `load`), tracks the in-flight state so the window can disable its controls, and
 * reflects the returned state back onto the execution store so the UI updates immediately even
 * before the stream echoes the change. Keyed by executionId, mirroring the fork-decision store.
 */
export const useJudgeStore = defineStore('judge', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()

  /** True while a resolve call is in flight (drives the buttons' spinner / disabled state). */
  const resolving = ref(false)
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  /**
   * Reflect an authoritative judge state onto the run's judge step. A pipeline may place more
   * than one judge, so target the step this verdict is about rather than the first one holding
   * judge state: prefer the step still awaiting a decision, then the current step, and only then
   * fall back to the first step carrying judge state.
   *
   * Only ever called through {@link ExecutionStore.echoAfter}, which drops the echo when the event
   * stream already delivered a newer revision — a `bounce` re-arms the producing step, so the
   * driver is emitting fresh state while this response is still in flight.
   */
  function assign(
    instance: ReturnType<typeof execution.getInstance> & object,
    state: JudgeStepState,
  ): void {
    const current = instance.steps[instance.currentStep]
    const step =
      instance.steps.find((s) => s.judge?.status === 'awaiting_decision') ??
      (current?.judge ? current : undefined) ??
      instance.steps.find((s) => s.judge)
    if (step) step.judge = state
  }

  /** Warm the live state from the GET (the stream also keeps it fresh). Best-effort. */
  async function load(executionId: string): Promise<void> {
    error.value = null
    try {
      await execution.echoAfter(
        executionId,
        () => api.getJudgeState(workspace.requireId(), executionId),
        (state, instance) => {
          if (state) assign(instance, state as JudgeStepState)
        },
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load'
    }
  }

  /**
   * Resolve the parked verdict: `proceed` advances the run despite the score, `bounce` sends the
   * work back to the producing step with the findings (plus any extra guidance) as rework, and
   * `stop` fails the run.
   */
  async function resolve(
    executionId: string,
    choice: 'proceed' | 'bounce' | 'stop',
    feedback?: string,
  ): Promise<void> {
    error.value = null
    resolving.value = true
    try {
      await execution.echoAfter(
        executionId,
        () =>
          api.resolveJudge(workspace.requireId(), executionId, {
            choice,
            ...(feedback ? { feedback } : {}),
          }),
        (state, instance) => assign(instance, state as JudgeStepState),
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to resolve'
      throw e
    } finally {
      resolving.value = false
    }
  }

  return { resolving, error, load, resolve }
})
