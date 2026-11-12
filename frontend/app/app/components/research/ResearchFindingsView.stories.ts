import type { Meta, StoryObj } from '@storybook/vue3'
import type { Project } from '@cat-factory/contracts'
import { researchBoardView } from '~/stories/research.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import ResearchFindingsView from './ResearchFindingsView.vue'

// The research kind's reader inside the project takeover: coverage, every question with its
// current answer, learnings, and the follow-up. Starting one sends a request no story answers.
const project: Project = {
  id: researchBoardView.projectId,
  accountId: null,
  kind: 'research',
  rootBlockId: 'blk_project',
  serviceIds: [],
  createdAt: 1,
}

const meta = {
  title: 'Board/Components/ResearchFindingsView',
  component: ResearchFindingsView,
  parameters: { width: 'panel' },
  decorators: [withSeed(() => seedWorkspace())],
  args: { project, board: researchBoardView },
} satisfies Meta<typeof ResearchFindingsView>
export default meta

type Story = StoryObj<typeof meta>

/** One answer, one blocked on a credential, one question still open. */
export const Default: Story = {}

/** A pinned definition that no longer resolves: the answers stay, under no topic. */
export const DefinitionGone: Story = { args: { board: { ...researchBoardView, definition: null } } }
