import type { Meta, StoryObj } from '@storybook/vue3'
import { researchBoardView, researchOutcomes } from '~/stories/research.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import type { Project } from '@cat-factory/contracts'
import ProjectOutcomeHistory from './ProjectOutcomeHistory.vue'

// Every outcome a project's tasks wrote, newest first, with its stream, its intent and where each
// body lives. An offloaded body that cannot be read is named as unavailable. Opening one sends a
// request no story answers.
const project: Project = {
  id: researchBoardView.projectId,
  accountId: null,
  kind: 'research',
  rootBlockId: 'blk_project',
  serviceIds: [],
  createdAt: 1,
}

const meta = {
  title: 'Board/Components/ProjectOutcomeHistory',
  component: ProjectOutcomeHistory,
  parameters: { width: 'panel' },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
    }),
  ],
  args: { project, outcomes: researchOutcomes },
} satisfies Meta<typeof ProjectOutcomeHistory>
export default meta

type Story = StoryObj<typeof meta>

/** One inline outcome and one offloaded to content storage. */
export const Default: Story = {}

/** The offloaded outcome's storage cannot serve its body now. */
export const Unavailable: Story = {
  args: {
    outcomes: researchOutcomes.map((r) =>
      r.storage.placement === 'offloaded'
        ? { ...r, storage: { ...r.storage, readable: false } }
        : r,
    ),
  },
}

/** A project no task has written to yet. */
export const Empty: Story = { args: { outcomes: [] } }
