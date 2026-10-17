import type { Meta, StoryObj } from '@storybook/vue3'
import { authService, boardBlocks, loginTask } from '~/stories/board.stories.mocks'
import { boardApi } from '~/stories/boardApi'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { withSnapshot } from '~/stories/withStores'
import BlockNode from './BlockNode.vue'

// A block on the board canvas, here a service frame with its header and its task lanes. Outside
// the canvas there is no pan or zoom; the frame draws at the size its block records.
const frame = { ...authService, size: { w: 760, h: 460 } }

const blocks = [
  ...boardBlocks.filter((b) => b.id !== frame.id && b.id !== loginTask.id),
  frame,
  { ...loginTask, executionId: 'exec_login' },
]

const meta = {
  title: 'Board/Components/BlockNode',
  component: BlockNode,
  // A dragged card or a resize sends a write, which `boardApi` answers from memory.
  parameters: { api: boardApi(blocks) },
  decorators: [withSnapshot(snapshot({ blocks, executions: [execution()] }))],
} satisfies Meta<typeof BlockNode>
export default meta

type Story = StoryObj<typeof meta>

/** The Auth Service frame. */
export const Default: Story = { args: { id: frame.id } }
