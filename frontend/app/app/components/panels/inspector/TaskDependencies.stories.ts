import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { boardBlocks, boardWith, logoutTask, rateLimitTask } from '~/stories/board.stories.mocks'
import { withBoard } from '~/stories/withStores'
import TaskDependencies from './TaskDependencies.vue'

// The tasks this task waits on. A merged dependency is neutral, an unmerged one is in the warning
// colour, and a dependency in another container is prefixed with that container's name. While any
// dependency is unmerged the header carries a warning icon, which shows even when the section is
// closed, and the body says the task is blocked. The section starts closed, so each story opens it.
const meta = {
  title: 'Inspector/Components/TaskDependencies',
  component: TaskDependencies,
  parameters: { width: 'panel' },
  decorators: [withBoard(boardBlocks)],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('inspector-section-toggle'))
  },
} satisfies Meta<typeof TaskDependencies>
export default meta

type Story = StoryObj<typeof meta>

/** Two dependencies in the Sessions module, one merged and one not: blocked. */
export const Default: Story = { args: { block: logoutTask } }

const unblocked = { ...logoutTask, dependsOn: ['task_refresh'] }

/** Its only dependency has merged, so there is no warning. */
export const Runnable: Story = {
  args: { block: unblocked },
  decorators: [withBoard(boardWith(unblocked))],
}

/** No dependencies: the empty state. */
export const Empty: Story = { args: { block: rateLimitTask } }

/** Closed, as the inspector first shows it: the count and the warning stay in the header. */
export const Closed: Story = { args: { block: logoutTask }, play: async () => {} }
