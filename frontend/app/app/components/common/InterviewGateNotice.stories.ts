import type { Meta, StoryObj } from '@storybook/vue3'
import InterviewGateNotice from './InterviewGateNotice.vue'

// What an interview-gate window shows in place of its questions when the interview is not
// waiting on the user: a pass is running, or the run stopped. The caller passes the copy.
const meta = {
  title: 'Primitives/Components/InterviewGateNotice',
  component: InterviewGateNotice,
  parameters: { width: 'panel' },
  args: { testid: 'story-notice' },
} satisfies Meta<typeof InterviewGateNotice>
export default meta

type Story = StoryObj<typeof meta>

export const Working: Story = {
  args: {
    variant: 'working',
    title: 'Reading the requirements',
    hint: 'This usually takes under a minute.',
  },
}

export const Failed: Story = {
  args: {
    variant: 'failed',
    title: 'The interview stopped',
    hint: 'The model returned nothing usable twice. Retry, or answer the questions yourself.',
  },
}
