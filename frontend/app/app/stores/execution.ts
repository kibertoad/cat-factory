import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  Decision,
  ExecutionInstance,
  Pipeline,
  PipelineStep,
  StepApproval,
} from '~/types/domain'
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

  /** Start `pipeline` against a block; the server marks the block in-progress. */
  async function start(blockId: string, pipeline: Pipeline) {
    const ws = useWorkspaceStore()
    await api.startExecution(ws.requireId(), blockId, { pipelineId: pipeline.id })
    await ws.refresh()
  }

  async function resolveDecision(instanceId: string, decisionId: string, choice: string) {
    const ws = useWorkspaceStore()
    await api.resolveDecision(ws.requireId(), instanceId, decisionId, { choice })
    await ws.refresh()
  }

  /** Approve a step's gated proposal (optionally edited); the run advances. */
  async function approveStep(instanceId: string, approvalId: string, proposal?: string) {
    const ws = useWorkspaceStore()
    await api.approveStep(ws.requireId(), instanceId, approvalId, { proposal })
    await ws.refresh()
  }

  /** Request changes on a gated proposal; the step re-runs with `feedback`. */
  async function requestStepChanges(instanceId: string, approvalId: string, feedback: string) {
    const ws = useWorkspaceStore()
    await api.requestStepChanges(ws.requireId(), instanceId, approvalId, { feedback })
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

  /** Cancel the execution running against a block and reset it to planned. */
  async function cancel(blockId: string) {
    const ws = useWorkspaceStore()
    await api.cancelExecution(ws.requireId(), blockId)
    instances.value = instances.value.filter((e) => e.blockId !== blockId)
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
    mergePr,
    cancel,
  }
})
