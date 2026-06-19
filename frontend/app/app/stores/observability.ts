import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LlmCallMetric } from '~/types/execution'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * LLM observability state: the full per-call model activity for a run (prompts,
 * responses, token usage, output-limit headroom, the transport-vs-execution
 * latency split). Fetched on demand when the drill-down panel opens — the board's
 * inline step rollups already arrive on the execution stream, so this store backs
 * only the deep dive + the LLM-friendly export. Per-workspace; nothing persisted.
 */
export const useObservabilityStore = defineStore('observability', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** Per-execution-id call list (newest first). */
  const callsByExecution = ref<Record<string, LlmCallMetric[]>>({})
  /** Execution ids currently loading. */
  const loading = ref<Set<string>>(new Set())
  /** Execution ids currently exporting. */
  const exporting = ref<Set<string>>(new Set())
  /** Last load error message per execution id, or null. */
  const errors = ref<Record<string, string | null>>({})

  function callsFor(executionId: string): LlmCallMetric[] {
    return callsByExecution.value[executionId] ?? []
  }
  function isLoading(executionId: string): boolean {
    return loading.value.has(executionId)
  }
  function isExporting(executionId: string): boolean {
    return exporting.value.has(executionId)
  }

  function withFlag(set: typeof loading, key: string, on: boolean) {
    const next = new Set(set.value)
    if (on) next.add(key)
    else next.delete(key)
    set.value = next
  }

  /** Load (or refresh) the per-call detail for a run. */
  async function load(executionId: string) {
    if (!workspace.workspaceId) return
    withFlag(loading, executionId, true)
    errors.value = { ...errors.value, [executionId]: null }
    try {
      const { calls } = await api.getLlmMetrics(workspace.requireId(), executionId)
      callsByExecution.value = { ...callsByExecution.value, [executionId]: calls }
    } catch (err) {
      errors.value = {
        ...errors.value,
        [executionId]: err instanceof Error ? err.message : 'Failed to load metrics',
      }
    } finally {
      withFlag(loading, executionId, false)
    }
  }

  /**
   * Fetch the LLM-friendly export bundle and trigger a client-side download. The
   * events socket auths via a Bearer header (a plain `<a download>` can't), so we
   * fetch the JSON through the API client and save it from a Blob.
   */
  async function downloadExport(executionId: string) {
    if (!workspace.workspaceId) return
    withFlag(exporting, executionId, true)
    try {
      const bundle = await api.exportLlmMetrics(workspace.requireId(), executionId)
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `llm-metrics-${executionId}.json`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      withFlag(exporting, executionId, false)
    }
  }

  return {
    callsByExecution,
    callsFor,
    isLoading,
    isExporting,
    errors,
    load,
    downloadExport,
  }
})
