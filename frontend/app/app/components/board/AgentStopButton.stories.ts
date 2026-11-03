import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { withConfirmDialog } from '~/stories/withConfirmDialog'
import { seedViewer, withSeed } from '~/stories/withStores'
import AgentStopButton from './AgentStopButton.vue'

// The Stop control on a running run, wherever the run shows: a board card, the inspector, a task
// panel. A click asks for confirmation first, because stopping kills the run's container and
// loses its work in flight. The confirm dialog is the app's one shared dialog, so the stories
// mount it beside the button.
const meta = {
  title: 'Board/Components/AgentStopButton',
  component: AgentStopButton,
  args: { runId: 'exec_login' },
  decorators: [withConfirmDialog],
} satisfies Meta<typeof AgentStopButton>
export default meta

type Story = StoryObj<typeof meta>

/** The small soft Stop button a card shows. */
export const Default: Story = {}

/** A board viewer cannot run or stop work: the button is disabled and its tooltip says why. */
export const ReadOnly: Story = {
  decorators: [withSeed(seedViewer)],
}

/** After a click: the destructive confirm, which says the run stays visible and can be retried. */
export const ConfirmOpen: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Stop' }))
  },
}
