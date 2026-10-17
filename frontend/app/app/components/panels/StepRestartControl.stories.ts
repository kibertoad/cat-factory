import type { Meta, StoryObj } from '@storybook/vue3'
import { restartExecutionContract } from '@cat-factory/contracts'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { apiPending } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { withSnapshot } from '~/stories/withStores'
import StepRestartControl from './StepRestartControl.vue'

// Restart the run from this step: the server runs it again from here, and keeps the earlier
// steps' output as context. The later steps' results are lost, so the first click only arms the
// control and a second one restarts. It shows nothing with no run behind the window, or on a step
// that waits for an approval. The run is the login run, on its coder step.
const meta = {
  title: 'Pipeline/Components/StepRestartControl',
  component: StepRestartControl,
  args: { instanceId: 'exec_login', stepIndex: 1 },
  decorators: [withSnapshot(snapshot({ executions: [execution()] }))],
} satisfies Meta<typeof StepRestartControl>
export default meta

type Story = StoryObj<typeof meta>

async function arm(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: /restart/i }))
}

/** The icon button. */
export const Default: Story = {}

/** One click: Restart from here and Cancel. */
export const Armed: Story = {
  play: async ({ canvasElement }) => {
    await arm(canvasElement)
    await within(canvasElement).findByRole('button', { name: 'Cancel' })
  },
}

/** The second click: the restart is in flight, so the button spins and Cancel disables. */
export const Restarting: Story = {
  parameters: {
    api: [
      apiPending(restartExecutionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login' },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await arm(canvasElement)
    await userEvent.click(within(canvasElement).getByRole('button', { name: /restart from here/i }))
    const cancel = within(canvasElement).getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toBeDisabled())
  },
}
