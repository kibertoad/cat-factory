import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AssistantCapability, AssistantTurn } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * In-app assistant state: what this deployment's assistant can do, and the last turn's outcome.
 *
 * Nothing is persisted server-side and nothing accumulates here: a turn is one prompt and one
 * outcome, and the board itself is where the result lives afterwards (the write arrives over the
 * live stream like any other, so the frame or task shows up without this store touching the board).
 * Keeping a transcript would be a second, staler record of changes the board already carries.
 *
 * Failures are NOT held here: every refusal a turn can raise is a `DomainError` the shared error
 * funnel (`usePipelineErrorToast`) already renders translated, copyable and with its request id.
 * The three OUTCOMES are the ones this store keeps, because they are answers rather than errors.
 */
export const useAssistantStore = defineStore('assistant', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  const capability = ref<AssistantCapability | null>(null)
  const turn = ref<AssistantTurn | null>(null)
  const running = ref(false)
  /** The prompt the last turn ran on, so a clarification can be re-asked with it in the box. */
  const lastPrompt = ref('')

  /** Whether a model is wired at all; unknown (not yet read) reads as unavailable. */
  const available = computed(() => capability.value?.available === true)
  const actions = computed(() => capability.value?.actions ?? [])

  /** Read what the assistant can do here. Idempotent: re-reading replaces the answer. */
  async function loadCapability(): Promise<void> {
    capability.value = await api.getAssistantCapability(workspace.requireId())
  }

  /**
   * Run one turn. Throws on a refusal so the caller can hand it to the error funnel; the three
   * outcomes (performed / needs_input / declined) come back as the resolved value.
   */
  async function run(prompt: string): Promise<AssistantTurn> {
    running.value = true
    lastPrompt.value = prompt
    try {
      const result = await api.runAssistantTurn(workspace.requireId(), prompt)
      turn.value = result
      return result
    } finally {
      running.value = false
    }
  }

  /** Forget the last outcome (the modal closing, or a fresh prompt being typed). */
  function reset(): void {
    turn.value = null
  }

  return { capability, turn, running, lastPrompt, available, actions, loadCapability, run, reset }
})
