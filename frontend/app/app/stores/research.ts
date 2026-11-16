import { defineStore } from 'pinia'
import type { Project, ResearchMode } from '@cat-factory/contracts'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { usePipelinesStore } from '~/stores/pipelines'

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
 * The research kind's own action on a project: a follow-up, which is an ordinary `research` task
 * under the project's root started on the research pipeline. Reading a project is the generic
 * project-view store's.
 */
export const useResearchStore = defineStore('research', () => {
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

  return { startFollowUp }
})
