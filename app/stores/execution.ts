import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Decision, ExecutionInstance, Pipeline, PipelineStep } from '~/types/domain'
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

  /** Start `pipeline` against a block; the server marks the block in-progress. */
  async function start(blockId: string, pipeline: Pipeline) {
    const ws = useWorkspaceStore()
    await api.startExecution(ws.requireId(), blockId, { pipelineId: pipeline.id })
    await ws.refresh()
  }

  /** Advance every running execution one tick on the server. */
  async function tick() {
    const ws = useWorkspaceStore()
    await api.tick(ws.requireId(), { ticks: 1 })
    await ws.refresh()
  }

  async function resolveDecision(instanceId: string, decisionId: string, choice: string) {
    const ws = useWorkspaceStore()
    await api.resolveDecision(ws.requireId(), instanceId, decisionId, { choice })
    await ws.refresh()
  }

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
    byId,
    getInstance,
    getByBlock,
    pendingDecisionCount,
    openDecisions,
    start,
    tick,
    resolveDecision,
    mergePr,
    cancel,
  }
})
