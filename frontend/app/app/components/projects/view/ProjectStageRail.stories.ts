import type { Meta, StoryObj } from '@storybook/vue3'
import type { Project, ProjectBoardView, ProjectStageView } from '@cat-factory/contracts'
import { researchBoardView } from '~/stories/research.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import ProjectStageRail from './ProjectStageRail.vue'

// A staged project's stages: one accepted, one awaiting its checkpoint with an acceptance report,
// one blocked on it. Starting or accepting sends a request no story answers.
const project: Project = {
  id: researchBoardView.projectId,
  accountId: null,
  kind: 'research',
  rootBlockId: 'blk_project',
  serviceIds: [],
  createdAt: 1,
}

const stage = (
  id: string,
  title: string,
  state: Partial<ProjectStageView['state']>,
  over: Partial<ProjectStageView['stage']> = {},
): ProjectStageView => ({
  stage: {
    id,
    title,
    taskType: 'research',
    after: [],
    consumes: [],
    produces: id,
    start: 'manual',
    checkpoint: true,
    repeatable: false,
    ...over,
  },
  state: {
    stageId: id,
    status: 'ready',
    stale: false,
    waitingOn: [],
    activeTaskId: null,
    latest: null,
    accepted: null,
    acceptance: null,
    ...state,
  },
  revision: 'none',
})

const board: ProjectBoardView = {
  ...researchBoardView,
  stages: [
    stage('discover', 'Discover', {
      status: 'done',
      latest: { id: 'pout_1', seq: 1, taskId: 'task_1' },
      accepted: { id: 'pout_1', seq: 1, taskId: 'task_1' },
    }),
    stage(
      'deepen',
      'Deepen',
      {
        status: 'awaiting-checkpoint',
        latest: { id: 'pout_2', seq: 2, taskId: 'task_2' },
        acceptance: {
          outcomeId: 'pout_2',
          assessedAt: 2,
          state: 'assessed',
          model: 'example:model',
          criteria: [
            {
              id: 'auth',
              statement: 'The auth scheme is named.',
              status: 'met',
              claim: 'met',
              rationale: 'The result names OAuth client credentials.',
              evidence: ['OAuth client credentials'],
              unfound: [],
              dropped: 0,
            },
            {
              id: 'limits',
              statement: 'Rate limits are known.',
              status: 'unverified',
              claim: 'met',
              rationale: 'Assumed from the docs.',
              evidence: ['7 requests per second'],
              unfound: ['7 requests per second'],
              dropped: 0,
            },
          ],
        },
      },
      { after: ['discover'], consumes: [{ stage: 'discover' }] },
    ),
    stage('build', 'Build', { status: 'blocked', waitingOn: ['deepen'] }, { after: ['deepen'] }),
  ],
}

const meta = {
  title: 'Board/Components/ProjectStageRail',
  component: ProjectStageRail,
  parameters: { width: 'panel' },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
    }),
  ],
  args: { project, board },
} satisfies Meta<typeof ProjectStageRail>
export default meta

type Story = StoryObj<typeof meta>

/** One stage done, one awaiting acceptance with its report, one blocked on it. */
export const Default: Story = {}

/** A stage whose upstream result changed after it was accepted. */
export const Stale: Story = {
  args: {
    board: {
      ...board,
      stages: [
        board.stages[0]!,
        { ...board.stages[1]!, state: { ...board.stages[1]!.state, stale: true } },
      ],
    },
  },
}
