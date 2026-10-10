import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AgentPromptDetail, AgentPromptSummary } from '~/types/agent-prompts'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's agent system-prompt overrides — the pipeline builder's prompt editor.
 *
 * Two shapes, deliberately loaded apart. The INDEX (`summaries`) says which agent kinds deviate
 * from what the product ships and is loaded with the builder, because it badges every step. A
 * kind's prompt BODIES (`detail`) are loaded only when the editor for that kind opens: a prompt
 * is thousands of characters and a pipeline has a dozen steps, so folding the bodies into the
 * index would make opening the builder pay for text nobody read.
 */
export const useAgentPromptsStore = defineStore('agentPrompts', () => {
  const api = useApi()

  const summaries = ref<AgentPromptSummary[]>([])
  const detail = ref<AgentPromptDetail | null>(null)
  const loadingIndex = ref(false)
  const loadingDetail = ref(false)
  const saving = ref(false)

  /** Agent kinds whose live prompt replaces the shipped one, for the builder's badges. */
  const customizedKinds = computed(
    () => new Set(summaries.value.filter((s) => s.customized).map((s) => s.agentKind)),
  )

  function isCustomized(agentKind: string): boolean {
    return customizedKinds.value.has(agentKind)
  }

  /**
   * Load the override index. Best-effort: the builder is fully usable without it (the badges
   * are an affordance, not the feature), and the endpoint 503s on a deployment that wires no
   * override store at all.
   */
  async function loadIndex() {
    const ws = useWorkspaceStore()
    if (!ws.workspaceId) return
    loadingIndex.value = true
    try {
      summaries.value = await api.listAgentPrompts(ws.requireId())
    } finally {
      loadingIndex.value = false
    }
  }

  /** Open one kind's editor state. Errors propagate — an editor with no prompt is useless. */
  async function load(agentKind: string) {
    const ws = useWorkspaceStore()
    detail.value = null
    loadingDetail.value = true
    try {
      detail.value = await api.getAgentPrompt(ws.requireId(), agentKind)
      return detail.value
    } finally {
      loadingDetail.value = false
    }
  }

  /**
   * Append a revision: new text, or `null` to go back to the shipped prompt. The server returns
   * the refreshed detail, so the editor re-renders from the server's view of the log rather
   * than a locally-guessed one — which is what makes a rejected concurrent save (409) leave the
   * user looking at what actually landed.
   */
  async function save(agentKind: string, text: string | null, restoredFrom?: number) {
    const ws = useWorkspaceStore()
    saving.value = true
    try {
      detail.value = await api.saveAgentPrompt(ws.requireId(), agentKind, {
        text,
        ...(restoredFrom !== undefined ? { restoredFrom } : {}),
      })
      await loadIndex()
      return detail.value
    } finally {
      saving.value = false
    }
  }

  function reset() {
    detail.value = null
  }

  return {
    summaries,
    detail,
    loadingIndex,
    loadingDetail,
    saving,
    customizedKinds,
    isCustomized,
    loadIndex,
    load,
    save,
    reset,
  }
})
