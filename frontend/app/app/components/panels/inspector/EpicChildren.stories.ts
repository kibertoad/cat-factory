import type { Meta, StoryObj } from '@storybook/vue3'
import { boardBlocks, boardWith, sessionEpic } from '~/stories/board.stories.mocks'
import { block } from '~/stories/block.stories.mocks'
import { withBoard } from '~/stories/withStores'
import EpicChildren from './EpicChildren.vue'

// An epic's member tasks, wherever they live on the board, grouped by service and then by module.
// A task directly under its service has no module heading. The header counts the merged members.
const meta = {
  title: 'Inspector/Components/EpicChildren',
  component: EpicChildren,
  parameters: { width: 'panel' },
  decorators: [withBoard(boardBlocks)],
} satisfies Meta<typeof EpicChildren>
export default meta

type Story = StoryObj<typeof meta>

/** Four members across two services, one of them merged. */
export const Default: Story = { args: { block: sessionEpic } }

const emptyEpic = block({
  id: 'epic_empty',
  title: 'Audit logging',
  level: 'epic',
  parentId: null,
  status: 'planned',
  progress: 0,
})

/** An epic with no members yet: the empty state. */
export const Empty: Story = {
  args: { block: emptyEpic },
  decorators: [withBoard(boardWith(emptyEpic))],
}
