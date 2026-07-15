import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PrReviewStepState } from '~/types/execution'
import { useApi } from '~/composables/useApi'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * The PR deep-review action surface. The live review state lives on the run's `pr-reviewer`
 * step (`step.prReview`) and is kept fresh by the execution stream, so the window reads it
 * straight off the execution store — this store only wraps the `resolve` action (and a warm-up
 * `load`), tracks the in-flight state so the window can disable its controls, and reflects the
 * returned state back onto the execution store so the UI updates immediately even before the
 * stream echoes the change. Keyed by executionId, mirroring the fork-decision store.
 */
export const usePrReviewStore = defineStore('prReview', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()

  /** True while a resolve call is in flight (drives the Finish button spinner / disabled state). */
  const resolving = ref(false)
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  /**
   * Reflect an authoritative PR-review state onto the run's `pr-reviewer` step. A pipeline could
   * carry more than one such step, so target the step this review is about: prefer the step that
   * is still awaiting a selection, then the current step, and only then the first step carrying
   * review state. The stream corrects any mismatch; this keeps the immediate optimistic echo on
   * the right step.
   */
  function reflect(executionId: string, state: PrReviewStepState | null): void {
    if (!state) return
    const instance = execution.getInstance(executionId)
    if (!instance) return
    const isLive = (s: (typeof instance.steps)[number]) =>
      s.agentKind === 'pr-reviewer' && s.prReview?.status === 'awaiting_selection'
    const current = instance.steps[instance.currentStep]
    const step =
      instance.steps.find(isLive) ??
      (current?.agentKind === 'pr-reviewer' && current.prReview ? current : undefined) ??
      instance.steps.find((s) => s.prReview)
    if (step) step.prReview = state
  }

  /** Warm the live state from the GET (the stream also keeps it fresh). Best-effort. */
  async function load(executionId: string): Promise<void> {
    error.value = null
    try {
      const state = await api.getPrReview(workspace.requireId(), executionId)
      reflect(executionId, state as PrReviewStepState | null)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load'
    }
  }

  /**
   * Resolve the review: record the curated finding selection and complete the read-only review
   * (the run then advances to done). PR 2 supports only the `finish` action.
   */
  async function resolve(executionId: string, findingIds: string[]): Promise<void> {
    error.value = null
    resolving.value = true
    try {
      const state = await api.resolvePrReview(workspace.requireId(), executionId, {
        action: 'finish',
        findingIds,
      })
      reflect(executionId, state as PrReviewStepState)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to resolve review'
      throw e
    } finally {
      resolving.value = false
    }
  }

  return { resolving, error, load, resolve }
})
