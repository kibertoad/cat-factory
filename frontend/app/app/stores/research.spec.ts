import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@cat-factory/contracts'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { RESEARCH_PIPELINE_ID, useResearchStore } from '~/stores/research'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * A follow-up is an ordinary `research` task under the project's root, started on the research
 * pipeline, so what this store owns is the shape of that create: the mode always rides the task's
 * fields, and an empty question list or revisit list is left out rather than sent as "none".
 */
const project: Project = {
  id: 'prj_1',
  accountId: null,
  kind: 'research',
  rootBlockId: 'blk_root',
  serviceIds: [],
  createdAt: 1,
}

describe('research store', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('creates a research task under the project root and starts it on the research pipeline', async () => {
    const board = useBoardStore()
    const addTask = vi.spyOn(board, 'addTask').mockResolvedValue({ id: 'blk_task' } as never)
    const start = vi.spyOn(useExecutionStore(), 'start').mockResolvedValue(true)

    const started = await useResearchStore().startFollowUp(project, {
      title: 'Clarify open answers',
      mode: 'clarify',
      questions: [],
      questionIds: ['scopes'],
    })

    expect(started).toBe(true)
    expect(addTask).toHaveBeenCalledWith('blk_root', 'Clarify open answers', undefined, {
      taskType: 'research',
      taskTypeFields: { researchMode: 'clarify', researchQuestionIds: ['scopes'] },
      pipelineId: RESEARCH_PIPELINE_ID,
    })
    expect(start).toHaveBeenCalledWith(
      'blk_task',
      expect.objectContaining({ id: RESEARCH_PIPELINE_ID }),
    )
  })

  it('does not start anything when the task could not be created', async () => {
    vi.spyOn(useBoardStore(), 'addTask').mockResolvedValue(undefined)
    const start = vi.spyOn(useExecutionStore(), 'start')

    const started = await useResearchStore().startFollowUp(project, {
      title: 'Extend',
      mode: 'extend',
      questions: ['Is there a sandbox?'],
      questionIds: [],
    })

    expect(started).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })
})
