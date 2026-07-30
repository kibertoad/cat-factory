import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { WorkspaceAgentSettings } from '~/types/agent-settings'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's per-agent-kind generation settings — the pipeline builder's output-budget
 * control, sitting beside the prompt editor.
 *
 * Unlike the prompt store there is only ONE shape to load: the whole configured set is a handful
 * of small rows (a kind that inherits has no row at all), so the index IS the detail and the
 * builder can badge every step and populate its editor from one request. There is nothing here
 * worth deferring the way a prompt body is.
 */
export const useAgentSettingsStore = defineStore('agentSettings', () => {
  const api = useApi()

  const settings = ref<WorkspaceAgentSettings[]>([])
  const loading = ref(false)
  const saving = ref(false)

  /** Configured ceilings by agent kind, for O(1) lookup while rendering a pipeline's steps. */
  const ceilingByKind = computed(() => {
    const out = new Map<string, number>()
    for (const row of settings.value) {
      if (row.maxOutputTokens != null) out.set(row.agentKind, row.maxOutputTokens)
    }
    return out
  })

  /** This kind's configured ceiling, or undefined when it inherits the deployment default. */
  function maxOutputTokensFor(agentKind: string): number | undefined {
    return ceilingByKind.value.get(agentKind)
  }

  /**
   * Load the configured set. Best-effort like the prompt index: the builder is fully usable
   * without it (every kind simply runs the deployment ceiling), and the endpoint 503s on a
   * deployment that wires no settings store at all.
   */
  async function load() {
    const ws = useWorkspaceStore()
    if (!ws.workspaceId) return
    loading.value = true
    try {
      settings.value = await api.listWorkspaceAgentSettings(ws.requireId())
    } finally {
      loading.value = false
    }
  }

  /**
   * Set (or clear, with `null`) one kind's output-token ceiling.
   *
   * Reconciles from the row the SERVER returned rather than the value sent: it answers `null`
   * once the kind is back to inheriting, which is the same signal the row should disappear —
   * so a clear and a set both land through one code path and the store can never keep a row the
   * server has dropped.
   */
  async function setMaxOutputTokens(agentKind: string, maxOutputTokens: number | null) {
    const ws = useWorkspaceStore()
    saving.value = true
    try {
      const updated = await api.updateWorkspaceAgentSettings(ws.requireId(), agentKind, {
        maxOutputTokens,
      })
      const rest = settings.value.filter((s) => s.agentKind !== agentKind)
      settings.value = updated
        ? [...rest, updated].sort((a, b) => a.agentKind.localeCompare(b.agentKind))
        : rest
      return updated
    } finally {
      saving.value = false
    }
  }

  return {
    settings,
    loading,
    saving,
    ceilingByKind,
    maxOutputTokensFor,
    load,
    setMaxOutputTokens,
  }
})
