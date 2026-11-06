import type { Meta, StoryObj } from '@storybook/vue3'
import { researchRevisions, researchView } from '~/stories/research.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import type { Project } from '@cat-factory/contracts'
import ResearchRevisionHistory from './ResearchRevisionHistory.vue'

// Every findings revision a research project's tasks wrote, newest first, with where each body
// lives. An offloaded body that cannot be read is named as unavailable. Opening one sends a
// request no story answers.
const project: Project = {
  id: researchView.projectId,
  accountId: null,
  kind: 'research',
  rootBlockId: 'blk_project',
  serviceIds: [],
  createdAt: 1,
}

const meta = {
  title: 'Board/Components/ResearchRevisionHistory',
  component: ResearchRevisionHistory,
  parameters: { width: 'panel' },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
    }),
  ],
  args: { project, revisions: researchRevisions },
} satisfies Meta<typeof ResearchRevisionHistory>
export default meta

type Story = StoryObj<typeof meta>

/** One inline revision and one offloaded to content storage. */
export const Default: Story = {}

/** The offloaded revision's storage cannot serve its body now. */
export const Unavailable: Story = {
  args: {
    revisions: researchRevisions.map((r) =>
      r.storage.placement === 'offloaded'
        ? { ...r, storage: { ...r.storage, readable: false } }
        : r,
    ),
  },
}

/** A project no research task has written to yet. */
export const Empty: Story = { args: { revisions: [] } }
