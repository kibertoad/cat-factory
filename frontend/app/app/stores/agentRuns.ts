import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AgentFailure, AgentRunKind, BootstrapJob, StepSubtasks } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'
import { useExecutionStore } from '~/stores/execution'

/**
 * A coarse, per-block view of the current "agent run" against a block, regardless
 * of which flow produced it — enough for the board to render a failure banner +
 * retry and a "working…" progress badge uniformly. The rich step-level UI still
 * reads the full {@link ExecutionInstance} from the execution store.
 */
export interface AgentRunSummary {
  blockId: string
  kind: AgentRunKind
  /** The run's own status: execution running|blocked|done|paused|failed,
   * bootstrap pending|running|succeeded|failed. */
  status: string
  /** Id of the run, for the unified retry endpoint. */
  runId: string
  /** Structured failure when `status` is `failed`; null otherwise. */
  failure: AgentFailure | null
  /** Latest subtask counts for a live progress bar (null until reported). */
  subtasks: StepSubtasks | null
}

/**
 * Unified failure/retry surface over BOTH agent flows. Bootstrap runs are held
 * here (they have no other home on the client); executions are read from the
 * execution store so they're never duplicated. `byBlock` merges the two so a
 * board card / inspector can look itself up and show the same failure banner +
 * retry whether the block was made by a bootstrap or is running a task pipeline.
 *
 * This replaces the old bootstrap-only `bootstrap.byBlock`/`retry`, whose retry
 * could silently vanish when the separate jobs projection failed to resolve.
 */
export const useAgentRunsStore = defineStore('agentRuns', () => {
  const api = useApi()
  const execution = useExecutionStore()
  // Same actionable-toast handling as the execution store: a retry refused with a tagged
  // 409 (e.g. the run is no longer in a retryable state, or the model has no provider) is
  // surfaced here so every retry surface (board card, inspector, task panel) is identical.
  const runErrors = usePipelineErrorToast()

  /** Bootstrap runs for this workspace, newest-first. */
  const bootstrapJobs = ref<BootstrapJob[]>([])

  /** Replace the cached bootstrap runs with a server snapshot. */
  function hydrate(jobs: BootstrapJob[]) {
    bootstrapJobs.value = [...jobs].sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Patch a bootstrap run from a real-time `bootstrap` event (or after launching
   * one): replace it in place by id, else prepend it. Keeps the service card
   * reactive to live progress without a refetch.
   */
  function upsertBootstrap(job: BootstrapJob) {
    const i = bootstrapJobs.value.findIndex((j) => j.id === job.id)
    if (i >= 0) bootstrapJobs.value[i] = job
    else bootstrapJobs.value.unshift(job)
  }

  /**
   * The current run summary per block, merged from execution instances (task
   * runs) and bootstrap runs (service frames). Executions take a block first;
   * a frame block has no execution, so the newest bootstrap run wins there.
   */
  const byBlock = computed<Record<string, AgentRunSummary>>(() => {
    const map: Record<string, AgentRunSummary> = {}
    for (const e of execution.instances) {
      map[e.blockId] = {
        blockId: e.blockId,
        kind: 'execution',
        status: e.status,
        runId: e.id,
        failure: e.failure ?? null,
        subtasks: e.steps[e.currentStep]?.subtasks ?? null,
      }
    }
    // `bootstrapJobs` is newest-first; keep the first (newest) seen per block.
    for (const job of bootstrapJobs.value) {
      if (!job.blockId || map[job.blockId]) continue
      map[job.blockId] = {
        blockId: job.blockId,
        kind: 'bootstrap',
        status: job.status,
        runId: job.id,
        failure: job.failure,
        subtasks: job.subtasks,
      }
    }
    return map
  })

  /**
   * Retry a failed run (bootstrap or execution) via the unified endpoint, then
   * refresh the snapshot so both stores rehydrate — the card flips from failed
   * back to "working…" as a fresh run is dispatched server-side.
   */
  async function retry(runId: string) {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    // A failed run on a Claude-pinned block needs the retrying user's personal password;
    // supplied from cache and prompted (then retried) on a 428, exactly like start.
    try {
      await personal.withCredential(async (password) => {
        await api.retryAgentRun(ws.requireId(), runId, password)
        await ws.refresh()
      })
    } catch (e) {
      runErrors.present(e, 'errors.action.retryFailed')
    }
  }

  /**
   * Explicitly stop a running run (bootstrap or execution) via the unified endpoint:
   * the backend kills the per-run container + tears down the durable driver, then
   * marks the run cancelled. Refresh so both stores rehydrate and the card flips out
   * of its "running" state. Returns the resolved kind so the caller can word a toast.
   */
  async function stop(runId: string): Promise<AgentRunKind> {
    const ws = useWorkspaceStore()
    const { kind } = await api.stopAgentRun(ws.requireId(), runId)
    await ws.refresh()
    return kind
  }

  return { bootstrapJobs, hydrate, upsertBootstrap, byBlock, retry, stop }
})
