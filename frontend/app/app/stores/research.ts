import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  FindingsStoragePolicy,
  FindingsStoragePolicyView,
  Project,
  ResearchMode,
  ResearchProjectView,
  ResearchRevisionDetail,
} from '@cat-factory/contracts'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { usePipelinesStore } from '~/stores/pipelines'
import { useWorkspaceStore } from '~/stores/workspace'

/** The pipeline a research follow-up runs: the platform's `pl_research`. */
export const RESEARCH_PIPELINE_ID = 'pl_research'

/** What a follow-up asks: its mode, questions it adds, and the ids it revisits. */
export interface ResearchFollowUpInput {
  title: string
  mode: ResearchMode
  questions: string[]
  questionIds: string[]
}

/**
 * Research projects' findings as this board reads them: one view per project (pin, fold,
 * coverage, revisions with where each body lives, credential readiness), the revision bodies a
 * reader opens, and the findings-storage tiers. Read on demand when a reader opens and re-read
 * when a research task under the project settles, so it holds nothing the snapshot hydrates.
 */
export const useResearchStore = defineStore('research', () => {
  const api = useApi()

  const views = ref<Record<string, ResearchProjectView>>({})
  const loading = ref<Record<string, boolean>>({})
  const policies = ref<Record<string, FindingsStoragePolicyView>>({})

  async function load(projectId: string): Promise<ResearchProjectView> {
    const ws = useWorkspaceStore()
    loading.value = { ...loading.value, [projectId]: true }
    try {
      const view = await api.getResearchProjectView(ws.requireId(), projectId)
      views.value = { ...views.value, [projectId]: view }
      return view
    } finally {
      loading.value = { ...loading.value, [projectId]: false }
    }
  }

  function revision(projectId: string, revisionId: string): Promise<ResearchRevisionDetail> {
    return api.getResearchRevision(useWorkspaceStore().requireId(), projectId, revisionId)
  }

  /**
   * Add a `research` task under the project and start it on `pl_research`. Returns false when
   * the task was created but the start was refused or cancelled (the execution store has already
   * presented why), so the caller keeps its form open.
   */
  async function startFollowUp(project: Project, input: ResearchFollowUpInput): Promise<boolean> {
    const board = useBoardStore()
    const fields = {
      researchMode: input.mode,
      ...(input.questions.length ? { researchQuestions: input.questions } : {}),
      ...(input.questionIds.length ? { researchQuestionIds: input.questionIds } : {}),
    }
    const block = await board.addTask(project.rootBlockId, input.title, undefined, {
      taskType: 'research',
      taskTypeFields: fields,
      pipelineId: RESEARCH_PIPELINE_ID,
    })
    if (!block) return false
    const pipeline = usePipelinesStore().getPipeline(RESEARCH_PIPELINE_ID)
    return useExecutionStore().start(block.id, {
      id: RESEARCH_PIPELINE_ID,
      name: pipeline?.name ?? RESEARCH_PIPELINE_ID,
    })
  }

  async function loadPolicy(projectId: string): Promise<FindingsStoragePolicyView> {
    const view = await api.getFindingsStoragePolicy(useWorkspaceStore().requireId(), projectId)
    policies.value = { ...policies.value, [projectId]: view }
    return view
  }

  async function setPolicy(
    projectId: string,
    tier: 'workspace' | 'project',
    policy: FindingsStoragePolicy | null,
  ): Promise<FindingsStoragePolicyView> {
    const ws = useWorkspaceStore()
    await api.setFindingsStoragePolicy(
      ws.requireId(),
      tier === 'workspace' ? { tier, policy } : { tier, projectId, policy },
    )
    return loadPolicy(projectId)
  }

  return { views, loading, policies, load, revision, startFollowUp, loadPolicy, setPolicy }
})
