import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, userEvent, within } from 'storybook/test'
import { failure } from '~/stories/pipelineStep.stories.mocks'
import FailureListEntry from './FailureListEntry.vue'

// One earlier failure in the inspector's "previous errors" list and in the step panel's execution
// history: when it occurred, its translated cause line, and the backend's text behind Details.
// The host owns the list item, so the stories render the body alone.
const meta = {
  title: 'Board/Components/FailureListEntry',
  component: FailureListEntry,
  parameters: { width: 'panel' },
  args: { failure: failure() },
} satisfies Meta<typeof FailureListEntry>
export default meta

type Story = StoryObj<typeof meta>

/** An evicted container: the time, the cause line, and Details closed. */
export const Default: Story = {}

/** Details open: the backend's message, its hint and the full output. */
export const DetailsOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }))
    await expect(await canvas.findByText('The container was lost mid-run.')).toBeVisible()
  },
}

/** No repository host connected: the cause line is the one the 409 toast uses. */
export const GithubNotConnected: Story = {
  args: {
    failure: failure({
      kind: 'preflight',
      reason: 'github_not_connected',
      message: "No connected GitHub repository found for workspace 'ws_story'.",
      detail: null,
      hint: null,
    }),
  },
}
