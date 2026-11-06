import type { Meta, StoryObj } from '@storybook/vue3'
import type { Project } from '@cat-factory/contracts'
import {
  getFindingsStoragePolicyContract,
  getResearchProjectViewContract,
} from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { researchPolicy, researchView } from '~/stories/research.stories.mocks'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import ResearchFindingsTakeover from './ResearchFindingsTakeover.vue'

// A research project's findings reader: the pinned definition, coverage, every question with its
// current answer, the revision history, credential readiness and (for who manages settings, in
// advanced mode) the storage tiers. Starting a follow-up sends a request no story answers.
const project: Project = {
  id: researchView.projectId,
  accountId: null,
  kind: 'research',
  rootBlockId: 'blk_project',
  serviceIds: [],
  createdAt: 1,
}

const meta = {
  title: 'Board/Components/ResearchFindingsTakeover',
  component: ResearchFindingsTakeover,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
    }),
  ],
  args: { open: true, project, title: 'Content platform research' },
  parameters: {
    api: [
      apiResponse(getResearchProjectViewContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { projectId: project.id },
        body: researchView,
      }),
      apiResponse(getFindingsStoragePolicyContract, {
        pathPrefix: storyWorkspacePrefix,
        body: researchPolicy,
      }),
    ],
  },
} satisfies Meta<typeof ResearchFindingsTakeover>
export default meta

type Story = StoryObj<typeof meta>

/** Two revisions folded: one answer, one blocked on a credential, one question still open. */
export const Default: Story = {}

/** A project whose pinned definition the deployment has since changed in code. */
export const DefinitionChanged: Story = {
  parameters: {
    api: [
      apiResponse(getResearchProjectViewContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { projectId: project.id },
        body: { ...researchView, definitionChanged: true },
      }),
    ],
  },
}
