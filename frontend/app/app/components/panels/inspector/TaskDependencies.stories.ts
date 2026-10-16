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
} satisfies Meta<typeof TaskDependencies>
export default meta

type Story = StoryObj<typeof meta>

/**
 * `InspectorSection` opens closed, so each play opens it first and then waits for what the story
 * shows.
 */
function opensTo(shown: (canvas: ReturnType<typeof within>) => Promise<unknown>) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('inspector-section-toggle'))
    await shown(within(canvasElement))
  }
}

/** Two dependencies in the Sessions module, one merged and one not: blocked. */
export const Default: Story = {
  args: { block: logoutTask },
  play: opensTo((c) => c.findByText('Blocked until dependencies merge.')),
}

const unblocked = { ...logoutTask, dependsOn: ['task_refresh'] }

/** Its only dependency has merged, so there is no warning. */
export const Runnable: Story = {
  args: { block: unblocked },
  decorators: [withBoard(boardWith(unblocked))],
  play: opensTo((c) => c.findByTitle('Merged')),
}

/** No dependencies: the empty state. */
export const Empty: Story = {
  args: { block: rateLimitTask },
  play: opensTo((c) => c.findByText('No dependencies. Can run any time.')),
}

/** Closed, as the inspector first shows it: the count and the warning stay in the header. */
export const Closed: Story = {
  args: { block: logoutTask },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('(2)')
  },
}
