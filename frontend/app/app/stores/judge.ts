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
   * fall back to the first step carrying judge state. The stream corrects any mismatch; this
   * keeps the immediate optimistic echo on the right step.
   */
  function reflect(executionId: string, state: JudgeStepState | null): void {
    if (!state) return
    const instance = execution.getInstance(executionId)
    if (!instance) return
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
      const state = await api.getJudgeState(workspace.requireId(), executionId)
      reflect(executionId, state as JudgeStepState | null)
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
      const state = await api.resolveJudge(workspace.requireId(), executionId, {
        choice,
        ...(feedback ? { feedback } : {}),
      })
      reflect(executionId, state as JudgeStepState)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to resolve'
      throw e
    } finally {
      resolving.value = false
    }
  }

  return { resolving, error, load, resolve }
})
