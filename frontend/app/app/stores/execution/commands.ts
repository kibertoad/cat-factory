import type { Ref } from 'vue'
import type { ExecutionInstance, Pipeline } from '~/types/domain'
import type { RequestStepChangesInput, RunMode } from '@cat-factory/contracts'
import type { IterationCapChoice } from '~/types/execution'
import type { ReviewEffort } from '~/types/merge'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Shared reactive state + injected dependencies the execution-store command factory closes
 * over. Created once in the `execution` store setup and threaded into
 * {@link createExecutionCommands} so the split operations stay behaviourally identical to the
 * original single-closure store — a size-only extraction mirroring `stores/board/` and
 * `stores/pipelines/`, not a new seam.
 */
export interface ExecutionCommandContext {
  api: ReturnType<typeof useApi>
  /** Centralised actionable toasts for run-control failures (see the store's note). */
  runErrors: ReturnType<typeof usePipelineErrorToast>
  instances: Ref<ExecutionInstance[]>
}

/**
 * The run-control commands (start / decide / approve / merge / restart / cancel / stop) the
 * execution store exposes. Each drives the backend and then refreshes the workspace snapshot,
 * since advancing a run also rolls status/progress up onto its block server-side.
 *
 * Every command that can (re-)dispatch a step rides the initiator's personal password through
 * `withCredential`, so an individual-usage (Claude/Codex) run re-mints its short-TTL activation
 * while the user is present instead of breaking mid-pipeline.
 */
export function createExecutionCommands(ctx: ExecutionCommandContext) {
  const { api, runErrors, instances } = ctx

  /**
   * Start `pipeline` against a block; the server marks the block in-progress. A block
   * pinned to an individual-usage model (Claude) needs the initiator's personal
   * password — supplied transparently from the local cache, and prompted via the
   * credential modal (then retried) when the server replies 428.
   *
   * `mode: 'dry_run'` REQUESTS a sandboxed run: the pipeline works and opens its pull request,
   * and nothing merges. It is a request, not a decision — the task's merge preset can sandbox a
   * role's runs whatever they asked for, so what the run got is read back off the run's own
   * `mode`, never assumed from what was sent here.
   *
   * Takes the id + name it actually sends and reports, not a whole {@link Pipeline}: a caller may
   * legitimately hold neither, because a task can be pinned to an INTERNAL pipeline that the
   * library withholds from every picker. Demanding the row there would force the caller to either
   * fabricate one or silently start something else.
   */
  async function start(
    blockId: string,
    pipeline: Pick<Pipeline, 'id' | 'name'>,
    options?: { mode?: RunMode },
  ): Promise<boolean> {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    // Returns false when the user cancels the personal-password prompt OR the start was
    // refused (a 409 conflict, surfaced as an actionable toast here), so an optimistic
    // caller can revert its "Starting…" state without its own error handling.
    try {
      return await personal.withCredential(async (password) => {
        await api.startExecution(
          ws.requireId(),
          blockId,
          // Omitted rather than `mode: 'live'` for an ordinary start: `live` is what the absent
          // field already means, and asking for it explicitly would read as a request to opt OUT
          // of a policy sandbox, which is not something a start may do.
          { pipelineId: pipeline.id, ...(options?.mode ? { mode: options.mode } : {}) },
          password,
        )
        await ws.refresh()
      })
    } catch (e) {
      runErrors.present(e, 'errors.action.startFailed')
      return false
    }
  }

  /**
   * Start ONE agent kind against a block. The single-kind counterpart of {@link start}: same
   * credential gate, same snapshot refresh, same false-on-refusal contract — only the thing being
   * started is an agent rather than a pipeline.
   */
  async function startAgentKind(blockId: string, agentKind: string): Promise<boolean> {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    try {
      return await personal.withCredential(async (password) => {
        await api.startAgentKindExecution(ws.requireId(), blockId, agentKind, password)
        await ws.refresh()
      })
    } catch (e) {
      runErrors.present(e, 'errors.action.startFailed')
      return false
    }
  }

  // Interacting with a running individual-usage run (resolve/approve/request-changes) advances
  // + re-dispatches the run, so the server re-mints its short-TTL activation from the personal
  // password first. It rides the cached password transparently, and — like start/retry — is
  // gated through `withCredential`: a within-buffer/lapsed cache re-prompts EARLY here (while
  // the user is present) rather than letting the run break mid-pipeline. For a non-individual
  // run the server ignores it and nothing prompts.
  async function resolveDecision(instanceId: string, decisionId: string, choice: string) {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    return await personal.withCredential(async (password) => {
      await api.resolveDecision(ws.requireId(), instanceId, decisionId, { choice }, password)
      await ws.refresh()
    })
  }

  /**
   * Approve a step's gated proposal (optionally edited); the run advances. Returns false —
   * with the failure surfaced as an actionable toast — when the server refused (e.g. a 409
   * for a park a dedicated window owns) or the user cancelled the credential prompt, so the
   * approval rail can stay open instead of closing over a silently-failed approve.
   */
  async function approveStep(
    instanceId: string,
    approvalId: string,
    proposal?: string,
  ): Promise<boolean> {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    try {
      return await personal.withCredential(async (password) => {
        await api.approveStep(ws.requireId(), instanceId, approvalId, { proposal }, password)
        await ws.refresh()
      })
    } catch (e) {
      runErrors.present(e, 'errors.action.approveFailed')
      return false
    }
  }

  /** Request changes on a gated proposal; the step re-runs with the review. Returns false
   *  (with a toast) on refusal / a cancelled credential prompt, like {@link approveStep}. */
  async function requestStepChanges(
    instanceId: string,
    approvalId: string,
    review: RequestStepChangesInput,
  ): Promise<boolean> {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    try {
      return await personal.withCredential(async (password) => {
        await api.requestStepChanges(ws.requireId(), instanceId, approvalId, review, password)
        await ws.refresh()
      })
    } catch (e) {
      runErrors.present(e, 'errors.action.requestChangesFailed')
      return false
    }
  }

  /** Reject a gated proposal; the run stops entirely (a retryable failure). Returns false
   *  (with a toast) when the server refused. */
  async function rejectStep(
    instanceId: string,
    approvalId: string,
    reason?: string,
  ): Promise<boolean> {
    const ws = useWorkspaceStore()
    try {
      await api.rejectStep(ws.requireId(), instanceId, approvalId, { reason })
      await ws.refresh()
      return true
    } catch (e) {
      runErrors.present(e, 'errors.action.rejectFailed')
      return false
    }
  }

  /**
   * Resolve a companion step parked at its rework cap: extra-round (one more pass) /
   * proceed (advance with the current output) / stop-reset (cancel + reset the task).
   * Rides the cached personal password (gated through `withCredential`, so a within-buffer
   * cache re-prompts early) for the server to re-mint the run's activation before
   * re-dispatching on extra-round/proceed.
   */
  async function resolveCompanionExceeded(
    instanceId: string,
    approvalId: string,
    choice: IterationCapChoice,
  ) {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    return await personal.withCredential(async (password) => {
      await api.resolveCompanionExceeded(
        ws.requireId(),
        instanceId,
        approvalId,
        { choice },
        password,
      )
      await ws.refresh()
    })
  }

  /**
   * Merge an open PR (a task in `pr_ready`) — the server completes the task. `reviewEffort` records
   * how much review the PR actually needed onto its merge track record in the same request; always
   * optional (an untagged merge records a null tag and nothing downstream breaks).
   */
  async function mergePr(blockId: string, reviewEffort?: ReviewEffort | null) {
    const ws = useWorkspaceStore()
    try {
      await api.mergeBlock(ws.requireId(), blockId, reviewEffort)
      await ws.refresh()
    } catch (e) {
      runErrors.present(e, 'errors.action.mergeFailed')
    }
  }

  /**
   * Restart a run from a chosen step: the server re-runs from `stepIndex` onward
   * (resetting that step + later steps' iteration counters) while preserving the
   * earlier steps' outputs as handoff context, and re-drives a fresh run. Like
   * start/retry it may dispatch an individual-usage (Claude) step, so it rides the
   * initiator's personal password — prompted (then retried) on a 428. Returns false
   * when the user cancels that prompt (nothing was restarted).
   */
  async function restartFromStep(instanceId: string, stepIndex: number): Promise<boolean> {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    try {
      return await personal.withCredential(async (password) => {
        await api.restartFromStep(ws.requireId(), instanceId, stepIndex, password)
        await ws.refresh()
      })
    } catch (e) {
      runErrors.present(e, 'errors.action.restartFailed')
      return false
    }
  }

  /**
   * Cancel the execution running against a block and reset it to planned. `workspaceId`
   * defaults to the current workspace but can be pinned by callers that cancel a run for a
   * board the user may have since navigated away from (e.g. a deferred delete's commit).
   */
  async function cancel(blockId: string, workspaceId?: string) {
    const ws = useWorkspaceStore()
    await api.cancelExecution(workspaceId ?? ws.requireId(), blockId)
    instances.value = instances.value.filter((e) => e.blockId !== blockId)
    await ws.refresh()
  }

  /**
   * Stop a running execution WITHOUT deleting it: halts the container + durable driver
   * and records the run as `cancelled` (a retryable failure), leaving the block
   * `blocked`. Unlike {@link cancel} the run is kept — its steps/output stay readable on
   * the board and it can be retried from where it stopped. `runId` is the execution id.
   */
  async function stop(runId: string) {
    const ws = useWorkspaceStore()
    await api.stopAgentRun(ws.requireId(), runId)
    await ws.refresh()
  }

  return {
    start,
    startAgentKind,
    resolveDecision,
    approveStep,
    requestStepChanges,
    rejectStep,
    resolveCompanionExceeded,
    restartFromStep,
    mergePr,
    cancel,
    stop,
  }
}
