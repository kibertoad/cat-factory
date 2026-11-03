import type { Meta, StoryObj } from '@storybook/vue3'
import IterationCapPrompt from './IterationCapPrompt.vue'

// What an iterative gate shows when its rework budget is spent and the bar is still unmet: one
// more round, proceed anyway, or stop and reset the task. Each choice has its own colour.
const meta = {
  title: 'Pipeline/Components/IterationCapPrompt',
  component: IterationCapPrompt,
  parameters: { width: 'panel' },
  args: {
    heading: 'The reviewer and the coder disagree after three rounds',
    detail: 'The automatic rework budget is spent. Another round costs roughly 40k tokens.',
  },
} satisfies Meta<typeof IterationCapPrompt>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

/** A choice is in flight: all three buttons show it, not only the one clicked. */
export const Loading: Story = { args: { loading: true } }
