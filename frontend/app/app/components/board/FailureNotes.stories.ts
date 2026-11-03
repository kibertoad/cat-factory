import type { Meta, StoryObj } from '@storybook/vue3'
import { failure } from '~/stories/pipelineStep.stories.mocks'
import FailureNotes from './FailureNotes.vue'

// What a failure's Details toggle shows: the backend's message, its notes for the operator (the
// per-kind hint) and the full output with a copy button. The host owns the toggle, so the stories
// show the body open. `error` is the tone inside the failure block, `neutral` the tone inside a
// list of earlier failures.
const meta = {
  title: 'Board/Components/FailureNotes',
  component: FailureNotes,
  parameters: { width: 'panel' },
  args: { failure: failure(), tone: 'error' },
} satisfies Meta<typeof FailureNotes>
export default meta

type Story = StoryObj<typeof meta>

/** All three sections, in the failure block's tone. */
export const Default: Story = {}

/** The tone of a list of earlier failures. */
export const Neutral: Story = {
  args: { tone: 'neutral' },
}

/**
 * The message only: no hint, and a detail that repeats the message, so the full output is not
 * shown a second time.
 */
export const MessageOnly: Story = {
  args: {
    failure: failure({
      message: 'The run ended without a reason.',
      detail: 'The run ended without a reason.',
      hint: null,
    }),
  },
}
