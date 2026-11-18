import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  Block,
  OutcomeStoragePolicy,
  OutcomeStoragePolicyView,
  ProjectBoardView,
  ProjectOutcomeDetail,
} from '@cat-factory/contracts'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Projects as this board reads them, whatever their kind: one view per project (pin, outcomes with
 * where each body lives, credential readiness, the kind's own view), the outcome bodies a reader
 * opens, and the outcome-storage tiers. Read on demand when a project opens and re-read when a
 * task under it settles, so it holds nothing the snapshot hydrates.
 */
export const useProjectViewsStore = defineStore('projectViews', () => {
  const api = useApi()

  const views = ref<Record<string, ProjectBoardView>>({})
  const loading = ref<Record<string, boolean>>({})
  const policies = ref<Record<string, OutcomeStoragePolicyView>>({})

  async function load(projectId: string): Promise<ProjectBoardView> {
    const ws = useWorkspaceStore()
    loading.value = { ...loading.value, [projectId]: true }
    try {
      const view = await api.getProjectBoardView(ws.requireId(), projectId)
      views.value = { ...views.value, [projectId]: view }
      return view
    } finally {
      loading.value = { ...loading.value, [projectId]: false }
    }
  }

  /**
   * Create a stage's task and answer it. The caller starts its run and re-reads the project: a
   * failed re-read is not a failed start.
   */
  function startStage(projectId: string, stageId: string): Promise<Block> {
    return api.startProjectStage(useWorkspaceStore().requireId(), projectId, stageId)
  }

  /** Accept a stage's result at its checkpoint, with a settlement where its task type takes one. */
  async function acceptStage(
    projectId: string,
    stageId: string,
    revision?: unknown,
  ): Promise<void> {
    await api.acceptProjectStage(useWorkspaceStore().requireId(), projectId, stageId, revision)
  }

  function outcome(projectId: string, outcomeId: string): Promise<ProjectOutcomeDetail> {
    return api.getProjectOutcome(useWorkspaceStore().requireId(), projectId, outcomeId)
  }

  async function loadPolicy(projectId: string): Promise<OutcomeStoragePolicyView> {
    const view = await api.getOutcomeStoragePolicy(useWorkspaceStore().requireId(), projectId)
    policies.value = { ...policies.value, [projectId]: view }
    return view
  }

  async function setPolicy(
    projectId: string,
    tier: 'workspace' | 'project',
    policy: OutcomeStoragePolicy | null,
  ): Promise<OutcomeStoragePolicyView> {
    const ws = useWorkspaceStore()
    await api.setOutcomeStoragePolicy(
      ws.requireId(),
      tier === 'workspace' ? { tier, policy } : { tier, projectId, policy },
    )
    return loadPolicy(projectId)
  }

  return {
    views,
    loading,
    policies,
    load,
    startStage,
    acceptStage,
    outcome,
    loadPolicy,
    setPolicy,
  }
})
