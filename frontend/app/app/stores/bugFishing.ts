import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { BugFishingStepState } from '~/types/execution'
import { useApi } from '~/composables/useApi'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * The bug-fishing expedition's action surface. The live state lives on the run's `bug-fisher`
 * step (`step.bugFishing`) and is kept fresh by the execution stream, so the window reads it
 * straight off the execution store — this store only wraps the actions, tracks what is in
 * flight so the window can disable its controls, and reflects the returned state back onto the
 * execution store so the UI updates before the stream echoes the change. Keyed by executionId,
 * mirroring the PR-review store.
 */
export const useBugFishingStore = defineStore('bugFishing', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()

  /**
   * The finding ids whose fix task is being spawned right now. A SET rather than one boolean
   * because marking is available while the expedition is still fishing, so a person can mark a
   * second finding while the first is still spawning — and a shared flag would grey out the row
   * they just clicked along with every other one.
   */
  const spawning = ref<Set<string>>(new Set())
  /** True while the finish call is in flight (drives the Finish button's spinner). */
  const resolving = ref(false)
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  /**
   * Apply an authoritative expedition state to the run's `bug-fisher` step. A pipeline could
   * carry more than one, so target the one this state is about: prefer the step still awaiting
   * triage, then the current step, then the first step carrying expedition state.
   *
   * Only ever called through {@link ExecutionStore.echoAfter}, which drops the echo when the
   * event stream already delivered a newer revision. That guard matters most here: marking a
   * finding is accepted mid-expedition, so an unguarded echo could put a later phase's findings
   * back to the set the mark request happened to see.
   */
  function assign(
    instance: ReturnType<typeof execution.getInstance> & object,
    state: BugFishingStepState,
  ): void {
    const isLive = (s: (typeof instance.steps)[number]) =>
      s.agentKind === 'bug-fisher' && s.bugFishing?.status === 'awaiting_triage'
    const current = instance.steps[instance.currentStep]
    const step =
      instance.steps.find(isLive) ??
      (current?.agentKind === 'bug-fisher' && current.bugFishing ? current : undefined) ??
      instance.steps.find((s) => s.bugFishing)
    if (step) step.bugFishing = state
  }

  /** Warm the live state from the GET (the stream also keeps it fresh). Best-effort. */
  async function load(executionId: string): Promise<void> {
    error.value = null
    try {
      await execution.echoAfter(
        executionId,
        () => api.getBugFishing(workspace.requireId(), executionId),
        (state, instance) => {
          if (state) assign(instance, state as BugFishingStepState)
        },
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load'
    }
  }

  /**
   * Mark findings to be addressed: each spawns its own bug-fix task, linked to the expedition.
   * `pipelineId` overrides the board's default fix pipeline for this batch only.
   */
  async function address(
    executionId: string,
    findingIds: string[],
    pipelineId?: string,
  ): Promise<void> {
    error.value = null
    spawning.value = new Set([...spawning.value, ...findingIds])
    try {
      await execution.echoAfter(
        executionId,
        () =>
          api.addressBugFishingFindings(workspace.requireId(), executionId, {
            findingIds,
            ...(pipelineId ? { pipelineId } : {}),
          }),
        (state, instance) => assign(instance, state as BugFishingStepState),
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create the fix task'
      throw e
    } finally {
      const next = new Set(spawning.value)
      for (const id of findingIds) next.delete(id)
      spawning.value = next
    }
  }

  /** Dismiss a finding: it stays on the record, struck through, and can no longer be marked. */
  async function dismiss(executionId: string, findingId: string): Promise<void> {
    error.value = null
    spawning.value = new Set([...spawning.value, findingId])
    try {
      await execution.echoAfter(
        executionId,
        () => api.dismissBugFishingFinding(workspace.requireId(), executionId, findingId),
        (state, instance) => assign(instance, state as BugFishingStepState),
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to dismiss the finding'
      throw e
    } finally {
      const next = new Set(spawning.value)
      next.delete(findingId)
      spawning.value = next
    }
  }

  /** Finish a parked expedition: triage is done and the run advances past the step. */
  async function resolve(executionId: string): Promise<void> {
    error.value = null
    resolving.value = true
    try {
      await execution.echoAfter(
        executionId,
        () => api.resolveBugFishing(workspace.requireId(), executionId),
        (state, instance) => assign(instance, state as BugFishingStepState),
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to finish the expedition'
      throw e
    } finally {
      resolving.value = false
    }
  }

  return { spawning, resolving, error, load, address, dismiss, resolve }
})
