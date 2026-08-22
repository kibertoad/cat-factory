import { ref } from 'vue'
import type { RunToolCallFailures, RunToolCallTrajectory } from '~/types/execution'
import { useSingleFlight } from '~/composables/useSingleFlight'

// The observability store's TOOL-CALL sink, extracted whole because it is one concern with two
// reads and its own coherence rule between them.
//
// The rule: the two reads answer at DIFFERENT BOUNDS and must never be mistaken for each other.
// `failures` is about the run — counts aggregated in SQL over every row it ever wrote. The
// trajectory is a bounded PREFIX of the run, carrying every captured argument and result, which
// is why it is loaded on demand rather than on open. Anything that counts, judges or headlines
// reads the first; only the browse view reads the second, and it renders under a flag saying so.
//
// Keeping that pairing in one module is the point of the split: a caller reaching for whichever
// list is nearest is exactly how a panel ends up reporting a long run's opening moves as
// everything it did.

/** What the sink needs from the API layer: the two reads, already bound to a workspace. */
export interface ToolCallSinkDeps {
  /**
   * Whether a workspace is resolved yet.
   *
   * Checked BEFORE either read rather than left to the binding throwing, because these loads
   * record their failures as "this sink did not answer" — a state the panel reports to an
   * operator — and "no workspace selected yet" is not that. It is nobody having asked.
   */
  ready: () => boolean
  fetchTrajectory: (executionId: string) => Promise<RunToolCallTrajectory & { executionId: string }>
  fetchFailures: (executionId: string) => Promise<RunToolCallFailures & { executionId: string }>
}

/**
 * What {@link ToolCallSinkState.toolCallsFor} answers for a run that was never loaded.
 *
 * A frozen shared value rather than a fresh object per call: this is read inside computeds, and a
 * new identity on every evaluation re-triggers every one of them downstream.
 */
export const EMPTY_TRAJECTORY: RunToolCallTrajectory = Object.freeze({
  toolCalls: Object.freeze([]) as never,
  truncated: false,
})

/** Add or remove a key from a reactive `Set` ref, replacing it so the reactivity fires. */
function withFlag(set: ReturnType<typeof ref<Set<string>>>, key: string, on: boolean) {
  const next = new Set(set.value)
  if (on) next.add(key)
  else next.delete(key)
  set.value = next
}

export function createToolCallSinkState(deps: ToolCallSinkDeps) {
  /**
   * One in-flight read per (sink, run). Both loads below fire on the panel OPENING, and the panel
   * has two openers that routinely land in the same tick, so each answered twice.
   */
  const loads = useSingleFlight<string, void>()

  /**
   * Per-execution-id trajectory PREFIX (oldest first, the order the agent worked in) with the
   * flag saying whether the run made more calls than it holds.
   */
  const toolCallsByExecution = ref<Record<string, RunToolCallTrajectory>>({})
  /** Execution ids whose trajectory is currently loading. */
  const toolCallsLoading = ref<Set<string>>(new Set())
  /**
   * Last trajectory-load error per execution id, or null. Recorded for the same reason the
   * context load records its own: a swallowed failure would render as the "no tool calls
   * recorded" empty state, which on this sink is a claim rather than a blank tab.
   */
  const toolCallErrors = ref<Record<string, string | null>>({})
  /**
   * Per-execution-id FAILING tool calls plus the run's exact counts.
   *
   * Separate from the trajectory because the numbers here are SQL aggregates over the whole run
   * while that list is a bounded prefix of it. Counting failures off the prefix is how a panel
   * ends up printing "nothing failed" over a run whose failures came after its opening moves.
   */
  const toolCallFailuresByExecution = ref<Record<string, RunToolCallFailures>>({})
  /** Execution ids whose failure summary is currently loading. */
  const toolCallFailuresLoading = ref<Set<string>>(new Set())
  /**
   * Last failure-summary load error per execution id, or null.
   *
   * The one error state the panel cannot afford to swallow: this read is what the pinned "what
   * failed" section speaks from, so a failure here has to reach it as "this sink did not answer"
   * rather than as the zero rows it would otherwise be indistinguishable from.
   */
  const toolCallFailureErrors = ref<Record<string, string | null>>({})

  /**
   * The loaded trajectory prefix, or the empty one.
   *
   * `truncated: false` on a run that was never loaded is not a claim that the run is short: a
   * caller distinguishes the two through {@link hasToolCalls}, never by finding this empty.
   */
  function toolCallsFor(executionId: string): RunToolCallTrajectory {
    return toolCallsByExecution.value[executionId] ?? EMPTY_TRAJECTORY
  }
  function isToolCallsLoading(executionId: string): boolean {
    return toolCallsLoading.value.has(executionId)
  }
  /** Whether the trajectory has ever been loaded for this run (an empty answer still counts). */
  function hasToolCalls(executionId: string): boolean {
    return executionId in toolCallsByExecution.value
  }

  /** Load (or refresh) the tool-call trajectory for a run. */
  function loadToolCalls(executionId: string): Promise<void> {
    return loads.run(`trajectory:${executionId}`, () => fetchToolCalls(executionId))
  }

  async function fetchToolCalls(executionId: string) {
    if (!deps.ready()) return
    withFlag(toolCallsLoading, executionId, true)
    toolCallErrors.value = { ...toolCallErrors.value, [executionId]: null }
    try {
      const { toolCalls, truncated } = await deps.fetchTrajectory(executionId)
      toolCallsByExecution.value = {
        ...toolCallsByExecution.value,
        [executionId]: { toolCalls, truncated },
      }
    } catch (err) {
      toolCallErrors.value = {
        ...toolCallErrors.value,
        [executionId]: err instanceof Error ? err.message : 'Failed to load tool calls',
      }
    } finally {
      withFlag(toolCallsLoading, executionId, false)
    }
  }

  /** The loaded failure summary, or null when this run's has not answered (yet, or at all). */
  function toolCallFailuresFor(executionId: string): RunToolCallFailures | null {
    return toolCallFailuresByExecution.value[executionId] ?? null
  }
  function isToolCallFailuresLoading(executionId: string): boolean {
    return toolCallFailuresLoading.value.has(executionId)
  }

  /**
   * Load (or refresh) the run's failing tool calls and exact counts.
   *
   * Cleared on failure rather than left holding the previous answer: a stale summary beside a
   * fresh error would let the panel keep asserting a failure count the backend just refused to
   * confirm.
   */
  function loadToolCallFailures(executionId: string): Promise<void> {
    return loads.run(`failures:${executionId}`, () => fetchToolCallFailures(executionId))
  }

  async function fetchToolCallFailures(executionId: string) {
    if (!deps.ready()) return
    withFlag(toolCallFailuresLoading, executionId, true)
    toolCallFailureErrors.value = { ...toolCallFailureErrors.value, [executionId]: null }
    try {
      const { total, failed, failures, failuresTruncated } = await deps.fetchFailures(executionId)
      toolCallFailuresByExecution.value = {
        ...toolCallFailuresByExecution.value,
        [executionId]: { total, failed, failures, failuresTruncated },
      }
    } catch (err) {
      const { [executionId]: _dropped, ...rest } = toolCallFailuresByExecution.value
      toolCallFailuresByExecution.value = rest
      toolCallFailureErrors.value = {
        ...toolCallFailureErrors.value,
        [executionId]: err instanceof Error ? err.message : 'Failed to load tool-call failures',
      }
    } finally {
      withFlag(toolCallFailuresLoading, executionId, false)
    }
  }

  /**
   * Drop every per-run cache. Called on a board SWITCH from the observability store's own
   * `reset`: an execution id belongs to the board that owns it, and nothing here is evicted
   * otherwise.
   */
  function resetToolCalls() {
    toolCallsByExecution.value = {}
    toolCallErrors.value = {}
    toolCallFailuresByExecution.value = {}
    toolCallFailureErrors.value = {}
  }

  return {
    resetToolCalls,
    toolCallsByExecution,
    toolCallErrors,
    toolCallsFor,
    hasToolCalls,
    isToolCallsLoading,
    loadToolCalls,
    toolCallFailuresByExecution,
    toolCallFailureErrors,
    toolCallFailuresFor,
    isToolCallFailuresLoading,
    loadToolCallFailures,
  }
}

export type ToolCallSinkState = ReturnType<typeof createToolCallSinkState>
