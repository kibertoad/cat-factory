import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LlmCallActivity, LlmCallMetric } from '~/types/execution'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * LLM observability state: the full per-call model activity for a run (prompts,
 * responses, token usage, output-limit headroom, the transport-vs-execution
 * latency split). Loaded on demand when the drill-down panel opens, then kept live:
 * the proxy pushes a compact `llmCall` event per model call over the workspace
 * stream, which `appendCall` folds in so an open panel updates in real time even
 * while the durable driver is evicted. Live-appended rows carry no prompt/response
 * bodies (the event stays small); the panel lazy-loads those for an expanded row
 * from the persisted metrics endpoint. Per-workspace; nothing persisted.
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
   * Fold a live `llmCall` activity event into the cached call list for its run, so an
   * open panel updates in real time. The compact event carries no prompt/response
   * bodies, so we materialise a {@link LlmCallMetric} with empty bodies + zeroed delta
   * fields; the panel lazy-loads the real bodies (by id) when the row is expanded.
   * Prepended (newest-first, matching `load`'s order) and deduped by id so a later
   * `load` that already includes the call, or a duplicate event, can't double it up.
   */
  function appendCall(activity: LlmCallActivity) {
    const executionId = activity.executionId
    if (!executionId) return
    const existing = callsByExecution.value[executionId] ?? []
    if (existing.some((c) => c.id === activity.id)) return
    const row: LlmCallMetric = {
      ...activity,
      promptText: '',
      promptPrefixCount: 0,
      promptHash: '',
      responseText: '',
    }
    callsByExecution.value = { ...callsByExecution.value, [executionId]: [row, ...existing] }
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
    appendCall,
    downloadExport,
  }
})
