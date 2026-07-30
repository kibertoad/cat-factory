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
  /** True while a chat send is in flight (drives the chat send spinner / disabled state). */
  const chatting = ref(false)
  /** The last error message from an action, surfaced inline; cleared on the next action. */
  const error = ref<string | null>(null)

  /**
   * Apply an authoritative fork-decision state to the run's Coder step. A pipeline may
   * carry more than one `coder` step, so target the step this decision is about rather than
   * the first one that happens to hold fork state: prefer the step that is still live
   * (proposing / awaiting the choice / answering), then the current step, and only then fall
   * back to the first step carrying fork state.
   *
   * Only ever called through {@link ExecutionStore.echoAfter}, which drops the echo when the event
   * stream already delivered a newer revision — without that guard this assignment silently
   * regressed the chat thread (see `echoAfter` for the failure it caused).
   */
  function assign(
    instance: ReturnType<typeof execution.getInstance> & object,
    state: ForkDecisionStepState,
  ): void {
    const isLive = (s: (typeof instance.steps)[number]) =>
      s.agentKind === 'coder' &&
      (s.forkDecision?.status === 'awaiting_choice' ||
        s.forkDecision?.status === 'answering' ||
        s.forkDecision?.status === 'proposing')
    const current = instance.steps[instance.currentStep]
    const step =
      instance.steps.find(isLive) ??
      (current?.agentKind === 'coder' && current.forkDecision ? current : undefined) ??
      instance.steps.find((s) => s.forkDecision)
    if (step) step.forkDecision = state
  }

  /** Warm the live state from the GET (the stream also keeps it fresh). Best-effort. */
  async function load(executionId: string): Promise<void> {
    error.value = null
    try {
      await execution.echoAfter(
        executionId,
        () => api.getForkDecision(workspace.requireId(), executionId),
        (state, instance) => {
          if (state) assign(instance, state as ForkDecisionStepState)
        },
      )
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
      await execution.echoAfter(
        executionId,
        () => api.chooseFork(workspace.requireId(), executionId, choice),
        (state, instance) => assign(instance, state as ForkDecisionStepState),
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to choose'
      throw e
    } finally {
      choosing.value = false
    }
  }

  /**
   * Send a grounded chat message about the surfaced forks. The reply is computed inline in the
   * durable driver and arrives via the execution stream; the immediate response is the
   * `answering` state (the human message already appended), echoed so the thread shows the sent
   * turn + a "thinking…" bubble without waiting for the stream.
   *
   * The echo is the RACIEST one in the app and must stay guarded: `chat` emits the one-message
   * `answering` state and then wakes the driver, which appends the reply and emits again, so with a
   * canned (no-model) reply the two-message thread frequently reaches the browser first. Applying
   * this response unconditionally dropped the reply and left the bubble spinning forever, since a
   * parked run emits nothing more.
   */
  async function chat(executionId: string, text: string): Promise<void> {
    error.value = null
    chatting.value = true
    try {
      await execution.echoAfter(
        executionId,
        () => api.forkChat(workspace.requireId(), executionId, text),
        (state, instance) => assign(instance, state as ForkDecisionStepState),
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to send message'
      throw e
    } finally {
      chatting.value = false
    }
  }

  return { choosing, chatting, error, load, choose, chat }
})
