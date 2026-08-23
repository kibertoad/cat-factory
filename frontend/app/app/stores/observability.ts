import { defineStore } from 'pinia'
import { ref } from 'vue'
import { LLM_CALL_LIST_LIMIT } from '@cat-factory/contracts'
import type { LlmCallActivity, LlmCallMetric } from '~/types/execution'
import { useWorkspaceStore } from '~/stores/workspace'
import { createToolCallSinkState } from '~/stores/observability/toolCalls'
import { createAgentContextSinkState } from '~/stores/observability/agentContext'
import { useSingleFlight } from '~/composables/useSingleFlight'

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

  /**
   * One in-flight read per run for the call log below. Its load is triggered by a panel OPENING,
   * and two openers in one tick is the normal case (the window and its shell, a deep link plus the
   * click behind it), so it fired twice for one answer. The extracted sinks hold their own.
   */
  const loads = useSingleFlight<string, void>()

  /**
   * The TOOL-CALL sink, extracted whole: two reads at two different bounds, plus the rule that
   * keeps them apart (see `observability/toolCalls.ts`). The store owns the workspace binding and
   * nothing else about it.
   */
  const toolCalls = createToolCallSinkState({
    ready: () => !!workspace.workspaceId,
    fetchTrajectory: (executionId) => api.getToolCalls(workspace.requireId(), executionId),
    fetchFailures: (executionId) => api.getToolCallFailures(workspace.requireId(), executionId),
  })

  /**
   * The AGENT-CONTEXT and SEARCH-QUERY sinks, extracted as one pair for the same reason as the
   * tool-call one beside it: both are per-dispatch records the panel loads on open and neither is
   * pushed live (see `observability/agentContext.ts`).
   */
  const agentContext = createAgentContextSinkState({
    ready: () => !!workspace.workspaceId,
    fetchContext: (executionId) => api.getAgentContext(workspace.requireId(), executionId),
    fetchSearchQueries: (executionId) => api.getSearchQueries(workspace.requireId(), executionId),
  })

  /**
   * How many calls one open run's list may hold before the oldest are evicted.
   *
   * The list is otherwise unbounded for the session: a watched run keeps appending, and every
   * append both scans the list for a duplicate id and re-allocates it, so a long run pays
   * quadratically for rows nobody scrolls back to.
   *
   * The bound is the SERVER's own read bound rather than a smaller number of our own, so this
   * cache never holds less than one read of the same run answers with. Sized lower, the first
   * live event on a run whose persisted log is longer than the cap would evict rows the server
   * DID answer with and report them as live-evicted, which is a count of calls the panel is
   * missing for a reason that never happened. At this size an eviction means the run has produced
   * more calls than a single read could show either way, which is the same story the server tells
   * by truncating.
   */
  const MAX_CALLS_PER_RUN = LLM_CALL_LIST_LIMIT

  /** Per-execution-id call list (newest first). */
  const callsByExecution = ref<Record<string, LlmCallMetric[]>>({})
  /**
   * How many rows the cap above evicted, per run. A capped list is NOT a prefix of the run and a
   * reader that assumes it is concludes the run made exactly the calls they are scrolling, so the
   * number it dropped is kept and stated.
   */
  const droppedCalls = ref<Record<string, number>>({})
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
  function load(executionId: string): Promise<void> {
    return loads.run(`calls:${executionId}`, () => fetchCalls(executionId))
  }

  async function fetchCalls(executionId: string) {
    if (!workspace.workspaceId) return
    withFlag(loading, executionId, true)
    errors.value = { ...errors.value, [executionId]: null }
    // Seed the key up front so this run counts as "opened": `appendCall` only folds
    // live events into already-opened runs, so seeding here both captures calls that
    // arrive DURING the fetch and lets the merge below preserve them.
    if (!callsByExecution.value[executionId]) {
      callsByExecution.value = { ...callsByExecution.value, [executionId]: [] }
    }
    try {
      const { calls } = await api.getLlmMetrics(workspace.requireId(), executionId)
      // Preserve live-streamed rows the persisted store hasn't caught up with yet: the
      // proxy emits the live `llmCall` event and writes the metric on INDEPENDENT paths,
      // so a just-observed call can reach the panel before its row is queryable here.
      // Server rows win (they carry the full bodies); the body-less live-only rows stay
      // newest-first ahead of them so a wholesale replace can't drop them mid-run.
      const fetchedIds = new Set(calls.map((c) => c.id))
      const liveOnly = (callsByExecution.value[executionId] ?? []).filter(
        (c) => !fetchedIds.has(c.id),
      )
      // Capped through the same helper as a live append, so the invariant holds on every write
      // rather than only on the append path. The read itself is server-bounded, so this only
      // trims where the live-only rows ahead of it push the merge past the bound.
      const { rows, dropped } = capCalls([...liveOnly, ...calls])
      callsByExecution.value = { ...callsByExecution.value, [executionId]: rows }
      // The list this read produced is the whole story now, so the count restarts from what the
      // merge itself dropped rather than carrying forward what an earlier live burst evicted.
      setDroppedCount(executionId, dropped)
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
   *
   * Gated to runs whose panel has been opened (`load` seeds the key): otherwise EVERY
   * model call in the workspace would accumulate here for runs the user never opens,
   * growing this store unbounded for the session's lifetime. An open panel still gets
   * its live updates because it loaded on open.
   */
  function appendCall(activity: LlmCallActivity) {
    const executionId = activity.executionId
    if (!executionId) return
    const existing = callsByExecution.value[executionId]
    if (!existing) return
    if (existing.some((c) => c.id === activity.id)) return
    const row: LlmCallMetric = {
      ...activity,
      // The live event carries the phase (the proxy knows it) but no turn ordinal — that is
      // the harness's job-scoped counter, which a proxied call has no equivalent of. Null is
      // what the stored row will say too, so the live row and the loaded one agree.
      turnIndex: null,
      promptText: '',
      promptPrefixCount: 0,
      promptHash: '',
      responseText: '',
      reasoningText: '',
    }
    const { rows, dropped } = capCalls([row, ...existing])
    callsByExecution.value = { ...callsByExecution.value, [executionId]: rows }
    if (dropped) setDroppedCount(executionId, droppedCallCount(executionId) + dropped)
  }

  /** Trim a run's list to {@link MAX_CALLS_PER_RUN}, newest kept, saying how many it dropped. */
  function capCalls(rows: LlmCallMetric[]): { rows: LlmCallMetric[]; dropped: number } {
    const dropped = Math.max(0, rows.length - MAX_CALLS_PER_RUN)
    return { rows: dropped ? rows.slice(0, MAX_CALLS_PER_RUN) : rows, dropped }
  }

  function setDroppedCount(executionId: string, count: number) {
    if (count === droppedCallCount(executionId)) return
    if (count > 0) {
      droppedCalls.value = { ...droppedCalls.value, [executionId]: count }
      return
    }
    const { [executionId]: _cleared, ...rest } = droppedCalls.value
    droppedCalls.value = rest
  }

  /** How many rows the per-run cap evicted from this run's list. */
  function droppedCallCount(executionId: string): number {
    return droppedCalls.value[executionId] ?? 0
  }

  /**
   * Drop every per-run cache. Called on a board SWITCH: an execution id is scoped to the board
   * that owns it, nothing here is part of the snapshot, and no id was ever evicted otherwise, so
   * without this the session accumulates every run of every board it visits. Each panel re-loads
   * on open, which is how these were populated in the first place.
   */
  function reset() {
    callsByExecution.value = {}
    droppedCalls.value = {}
    errors.value = {}
    agentContext.resetAgentContext()
    toolCalls.resetToolCalls()
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
    droppedCallCount,
    reset,
    isLoading,
    isExporting,
    errors,
    load,
    appendCall,
    downloadExport,
    ...agentContext,
    ...toolCalls,
  }
})
