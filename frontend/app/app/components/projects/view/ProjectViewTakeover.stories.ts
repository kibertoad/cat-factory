import type { Meta, StoryObj } from '@storybook/vue3'
import type { Project } from '@cat-factory/contracts'
import {
  getOutcomeStoragePolicyContract,
  getProjectBoardViewContract,
  getProjectOutcomeContract,
} from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { boardBlocks } from '~/stories/board.stories.mocks'
import {
  notesBoardView,
  notesOutcomeBody,
  outcomePolicy,
  researchBoardView,
} from '~/stories/research.stories.mocks'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import ProjectViewTakeover from './ProjectViewTakeover.vue'

// A project opened from its root: the reader its kind contributes (research's findings reader
// here), the outcome history, credential readiness and (for who manages settings, in advanced
// mode) the storage tiers. A kind with no reader shows its newest outcome per stream. Starting a
// research follow-up sends a request no story answers.
const project: Project = {
  id: researchBoardView.projectId,
  accountId: null,
  kind: 'research',
  rootBlockId: 'blk_project',
  serviceIds: [],
  createdAt: 1,
}

const meta = {
  title: 'Board/Components/ProjectViewTakeover',
  component: ProjectViewTakeover,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
    }),
  ],
  args: { open: true, project, title: 'Content platform research' },
  parameters: {
    api: [
      apiResponse(getProjectBoardViewContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { projectId: project.id },
        body: researchBoardView,
      }),
      apiResponse(getOutcomeStoragePolicyContract, {
        pathPrefix: storyWorkspacePrefix,
        body: outcomePolicy,
      }),
    ],
  },
} satisfies Meta<typeof ProjectViewTakeover>
export default meta

type Story = StoryObj<typeof meta>

/** A research project: one answer, one blocked on a credential, one question still open. */
export const Default: Story = {}

/** A project whose pinned definition the deployment has since changed in code. */
export const DefinitionChanged: Story = {
  parameters: {
    api: [
      apiResponse(getProjectBoardViewContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { projectId: project.id },
        body: { ...researchBoardView, definitionChanged: true },
      }),
    ],
  },
}

/** A project of a kind that contributes no reader: its newest outcome, as recorded. */
export const KindWithoutReader: Story = {
  args: {
    project: { ...project, id: notesBoardView.projectId, kind: 'notes' },
    title: 'Release notes',
  },
  parameters: {
    api: [
      apiResponse(getProjectBoardViewContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { projectId: notesBoardView.projectId },
        body: notesBoardView,
      }),
      apiResponse(getProjectOutcomeContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { projectId: notesBoardView.projectId, outcomeId: 'pout_note_1' },
        body: { ...notesBoardView.outcomes[0]!, body: notesOutcomeBody },
      }),
    ],
  },
}
