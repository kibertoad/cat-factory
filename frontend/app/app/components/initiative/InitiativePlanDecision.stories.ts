import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import InitiativePlanDecision from './InitiativePlanDecision.vue'

// The decision on an initiative's plan: approve it, or send it back with feedback. Send back
// needs something to act on, typed feedback or anchored comments; until then its tooltip asks
// for feedback. Without the right to run, both buttons are disabled with a tooltip that says so.
const meta = {
  title: 'Review/Components/InitiativePlanDecision',
  component: InitiativePlanDecision,
  parameters: { width: 'panel' },
  args: { approvalId: 'appr_auth_plan', instanceId: 'exec_auth_plan', canExecute: true },
} satisfies Meta<typeof InitiativePlanDecision>
export default meta

type Story = StoryObj<typeof meta>

/** No feedback: Approve is enabled, Send back is not. */
export const Default: Story = {}

/** Feedback typed: Send back is enabled. */
export const WithFeedback: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.type(
      within(canvasElement).getByTestId('initiative-plan-feedback'),
      'Split the session phase in two: revoke first, then rotate.',
    )
    const sendBack = within(canvasElement).getByTestId('initiative-plan-send-back')
    await waitFor(() => expect(sendBack).toBeEnabled())
  },
}

/** An anchored comment from the plan document: Send back is enabled with no typed feedback. */
export const WithComments: Story = {
  args: {
    comments: [
      {
        quotedSource: 'Phase 2: rotate refresh tokens on use.',
        srcStart: 412,
        srcEnd: 450,
        body: 'This needs the revocation list from phase 1 first.',
      },
    ],
  },
}

/** No right to run: both buttons are disabled. */
export const ReadOnly: Story = { args: { canExecute: false } }
