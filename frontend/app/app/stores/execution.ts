import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  Decision,
  ExecutionInstance,
  Pipeline,
  PipelineStep,
  StepApproval,
} from '~/types/domain'
import type { IterationCapChoice, ReviewComment } from '~/types/execution'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Running pipeline instances. The simulation engine lives on the backend: this
 * store mirrors the server's executions and drives them via the API. Commands
 * call the worker and then refresh the workspace snapshot, since advancing an
 * execution also rolls status/progress up onto its block server-side.
 */
export const useExecutionStore = defineStore('execution', () => {
  const api = useApi()
  const instances = ref<ExecutionInstance[]>([])

  /** Replace the cached executions with a server snapshot. */
  function hydrate(next: ExecutionInstance[]) {
    instances.value = next
  }

  /** Insert or replace a single execution instance pushed by the event stream. */
  function upsert(instance: ExecutionInstance) {
    const i = instances.value.findIndex((e) => e.id === instance.id)
    if (i >= 0) instances.value[i] = instance
    else instances.value.push(instance)
  }

  const byId = computed(() => {
    const map = new Map<string, ExecutionInstance>()
    for (const e of instances.value) map.set(e.id, e)
    return map
  })

  function getInstance(id: string | null | undefined) {
    return id ? byId.value.get(id) : undefined
  }

  function getByBlock(blockId: string) {
    return instances.value.find((e) => e.blockId === blockId)
  }

  /** How many decisions anywhere are awaiting a human. */
  const pendingDecisionCount = computed(() =>
    instances.value.reduce(
      (n, e) => n + e.steps.filter((s) => s.decision && !s.decision.chosen).length,
      0,
    ),
  )

  /** All currently-unresolved decisions across all runs (for the toolbar/queue). */
  const openDecisions = computed(() => {
    const out: {
      instanceId: string
      blockId: string
      decision: Decision
      agentKind: PipelineStep['agentKind']
    }[] = []
    for (const e of instances.value) {
      for (const s of e.steps) {
        if (s.decision && !s.decision.chosen) {
          out.push({
            instanceId: e.id,
            blockId: e.blockId,
            decision: s.decision,
            agentKind: s.agentKind,
          })
        }
      }
    }
    return out
  })

  /** All currently-pending approval gates across all runs (board badges/queue). */
  const openApprovals = computed(() => {
    const out: {
      instanceId: string
      blockId: string
      approval: StepApproval
      agentKind: PipelineStep['agentKind']
    }[] = []
    for (const e of instances.value) {
      for (const s of e.steps) {
        if (s.approval?.status === 'pending') {
          out.push({
            instanceId: e.id,
            blockId: e.blockId,
            approval: s.approval,
            agentKind: s.agentKind,
          })
        }
      }
    }
    return out
  })

  /**
   * Start `pipeline` against a block; the server marks the block in-progress. A block
   * pinned to an individual-usage model (Claude) needs the initiator's personal
   * password — supplied transparently from the local cache, and prompted via the
   * credential modal (then retried) when the server replies 428.
   */
  async function start(blockId: string, pipeline: Pipeline): Promise<boolean> {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    // Returns false when the user cancels the personal-password prompt (the run never
    // started), so an optimistic caller can revert its "Starting…" state.
    return personal.withCredential(async (password) => {
      await api.startExecution(ws.requireId(), blockId, { pipelineId: pipeline.id }, password)
      await ws.refresh()
    })
  }

  // Interacting with a running individual-usage run (resolve/approve/request-changes) rides
  // the CACHED personal password along transparently so the server can re-mint the run's
  // short-TTL activation before advancing — no prompt here (the user is only re-prompted on
  // start/retry, once the cache lapses). For a non-individual run the server ignores it.
  async function resolveDecision(instanceId: string, decisionId: string, choice: string) {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    await api.resolveDecision(
      ws.requireId(),
      instanceId,
      decisionId,
      { choice },
      personal.getCachedPassword(),
    )
    await ws.refresh()
  }

  /** Approve a step's gated proposal (optionally edited); the run advances. */
  async function approveStep(instanceId: string, approvalId: string, proposal?: string) {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    await api.approveStep(
      ws.requireId(),
      instanceId,
      approvalId,
      { proposal },
      personal.getCachedPassword(),
    )
    await ws.refresh()
  }

  /** Request changes on a gated proposal; the step re-runs with the review. */
  async function requestStepChanges(
    instanceId: string,
    approvalId: string,
    review: { feedback?: string; comments?: ReviewComment[] },
  ) {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    await api.requestStepChanges(
      ws.requireId(),
      instanceId,
      approvalId,
      review,
      personal.getCachedPassword(),
    )
    await ws.refresh()
  }

  /** Reject a gated proposal; the run stops entirely (a retryable failure). */
  async function rejectStep(instanceId: string, approvalId: string, reason?: string) {
    const ws = useWorkspaceStore()
    await api.rejectStep(ws.requireId(), instanceId, approvalId, { reason })
    await ws.refresh()
  }

  /**
   * Resolve a companion step parked at its rework cap: extra-round (one more pass) /
   * proceed (advance with the current output) / stop-reset (cancel + reset the task).
   * Rides the cached personal password so the server can re-mint the run's activation
   * before re-dispatching on extra-round/proceed.
   */
  async function resolveCompanionExceeded(
    instanceId: string,
    approvalId: string,
    choice: IterationCapChoice,
  ) {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    await api.resolveCompanionExceeded(
      ws.requireId(),
      instanceId,
      approvalId,
      { choice },
      personal.getCachedPassword(),
    )
    await ws.refresh()
  }

  /** How many approval gates anywhere are awaiting a human. */
  const pendingApprovalCount = computed(() =>
    instances.value.reduce(
      (n, e) => n + e.steps.filter((s) => s.approval?.status === 'pending').length,
      0,
    ),
  )

  /** Merge an open PR (a task in `pr_ready`) — the server completes the task. */
  async function mergePr(blockId: string) {
    const ws = useWorkspaceStore()
    await api.mergeBlock(ws.requireId(), blockId)
    await ws.refresh()
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
    return personal.withCredential(async (password) => {
      await api.restartFromStep(ws.requireId(), instanceId, stepIndex, password)
      await ws.refresh()
    })
  }

  /** Cancel the execution running against a block and reset it to planned. */
  async function cancel(blockId: string) {
    const ws = useWorkspaceStore()
    await api.cancelExecution(ws.requireId(), blockId)
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
    instances,
    hydrate,
    upsert,
    byId,
    getInstance,
    getByBlock,
    pendingDecisionCount,
    openDecisions,
    openApprovals,
    pendingApprovalCount,
    start,
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
})
