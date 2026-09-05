import { ref } from 'vue'
import type { AgentContextSnapshot, AgentSearchQuery } from '~/types/execution'
import { useSingleFlight } from '~/composables/useSingleFlight'
import { withFlag } from './withFlag'

/** What the two reads need from the store: the workspace binding, nothing else. */
export interface AgentContextSinkDeps {
  /** Whether a workspace is bound; a load is a no-op before one is. */
  ready: () => boolean
  fetchContext: (executionId: string) => Promise<{ snapshots: AgentContextSnapshot[] }>
  fetchSearchQueries: (executionId: string) => Promise<{ searchQueries: AgentSearchQuery[] }>
}

/**
 * The observability store's AGENT-CONTEXT and SEARCH-QUERY sinks, extracted as one cohesive pair:
 * both are per-dispatch records the drill-down panel loads on open, neither is pushed live, and
 * both are dropped together on a board switch. A size-only split mirroring
 * `createToolCallSinkState`, which sits beside it for the same reason.
 *
 * The two differ in ONE way, deliberately: a failed context load is RECORDED, because a swallowed
 * error there renders as the "no context stored" empty state, which is a claim about the run
 * rather than a blank tab. A search-query load has no such claim to make.
 */
export function createAgentContextSinkState(deps: AgentContextSinkDeps) {
  /** One in-flight read per (sink, run): a panel's two openers routinely fire in the same tick. */
  const loads = useSingleFlight<string, void>()

  /** Per-execution-id provided-context snapshot list (newest first). */
  const contextByExecution = ref<Record<string, AgentContextSnapshot[]>>({})
  /** Execution ids whose context is currently loading. */
  const contextLoading = ref<Set<string>>(new Set())
  /**
   * Last context-load error message per execution id, or null. Distinguishes a genuine fetch
   * failure from a run with no captured context: without this, a swallowed error rendered as
   * the "no context stored" empty state, indistinguishable from success-with-nothing.
   */
  const contextErrors = ref<Record<string, string | null>>({})
  /** Per-execution-id performed-search-query list (newest first). */
  const searchQueriesByExecution = ref<Record<string, AgentSearchQuery[]>>({})
  /** Execution ids whose search queries are currently loading. */
  const searchQueriesLoading = ref<Set<string>>(new Set())

  function contextFor(executionId: string): AgentContextSnapshot[] {
    return contextByExecution.value[executionId] ?? []
  }
  function isContextLoading(executionId: string): boolean {
    return contextLoading.value.has(executionId)
  }

  /** Load (or refresh) the per-dispatch provided-context snapshots for a run. */
  function loadContext(executionId: string): Promise<void> {
    return loads.run(`context:${executionId}`, () => fetchContext(executionId))
  }

  async function fetchContext(executionId: string) {
    if (!deps.ready()) return
    withFlag(contextLoading, executionId, true)
    contextErrors.value = { ...contextErrors.value, [executionId]: null }
    try {
      const { snapshots } = await deps.fetchContext(executionId)
      contextByExecution.value = { ...contextByExecution.value, [executionId]: snapshots }
    } catch (err) {
      // Record the error so the panel can offer a retry instead of masquerading the failure as
      // the "no context stored" empty state.
      contextErrors.value = {
        ...contextErrors.value,
        [executionId]: err instanceof Error ? err.message : 'Failed to load context',
      }
    } finally {
      withFlag(contextLoading, executionId, false)
    }
  }

  function searchQueriesFor(executionId: string): AgentSearchQuery[] {
    return searchQueriesByExecution.value[executionId] ?? []
  }
  function isSearchQueriesLoading(executionId: string): boolean {
    return searchQueriesLoading.value.has(executionId)
  }

  /** Load (or refresh) the performed web-search queries for a run. */
  function loadSearchQueries(executionId: string): Promise<void> {
    return loads.run(`searchQueries:${executionId}`, () => fetchSearchQueries(executionId))
  }

  async function fetchSearchQueries(executionId: string) {
    if (!deps.ready()) return
    withFlag(searchQueriesLoading, executionId, true)
    try {
      const { searchQueries } = await deps.fetchSearchQueries(executionId)
      searchQueriesByExecution.value = {
        ...searchQueriesByExecution.value,
        [executionId]: searchQueries,
      }
    } catch {
      // Best-effort: the panel shows an empty state; nothing is persisted client-side.
    } finally {
      withFlag(searchQueriesLoading, executionId, false)
    }
  }

  /** Drop both sinks. Called on a board switch from the observability store's own `reset`. */
  function resetAgentContext() {
    contextByExecution.value = {}
    contextErrors.value = {}
    searchQueriesByExecution.value = {}
  }

  return {
    contextByExecution,
    contextErrors,
    contextFor,
    isContextLoading,
    loadContext,
    searchQueriesByExecution,
    searchQueriesFor,
    isSearchQueriesLoading,
    loadSearchQueries,
    resetAgentContext,
  }
}
