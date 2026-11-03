import type { Meta, StoryObj } from '@storybook/vue3'
import { authService, boardBlocks, boardWith, sessionsModule } from '~/stories/board.stories.mocks'
import { block } from '~/stories/block.stories.mocks'
import { withBoard } from '~/stories/withStores'
import ContainerSummary from './ContainerSummary.vue'

// What a service or a module contains. A service shows its modules (with a task count each) and
// every task under it, including the tasks inside its modules; a module shows its own tasks. Each
// task has its status dot and label. Both sections start open.
const meta = {
  title: 'Inspector/Components/ContainerSummary',
  component: ContainerSummary,
  parameters: { width: 'panel' },
  decorators: [withBoard(boardBlocks)],
} satisfies Meta<typeof ContainerSummary>
export default meta

type Story = StoryObj<typeof meta>

/** A service with one module: the module list, then all three of its tasks. */
export const Default: Story = { args: { block: authService } }

/** A module: its two tasks, and no module list. */
export const Module: Story = { args: { block: sessionsModule } }

const billing = block({ id: 'svc_billing', title: 'Billing', level: 'frame', parentId: null })

/** A service with nothing in it: no module list, and the empty state for tasks. */
export const Empty: Story = {
  args: { block: billing },
  decorators: [withBoard(boardWith(billing))],
}
