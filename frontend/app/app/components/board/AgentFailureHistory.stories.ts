import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { failure } from '~/stories/pipelineStep.stories.mocks'
import AgentFailureHistory from './AgentFailureHistory.vue'

// The collapsed "previous errors" disclosure in the inspector's task execution section. It keeps
// the errors of earlier attempts readable after a retry has cleared the failure banner. An empty
// trail renders nothing.
const meta = {
  title: 'Inspector/Components/AgentFailureHistory',
  component: AgentFailureHistory,
  parameters: { width: 'panel' },
} satisfies Meta<typeof AgentFailureHistory>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { failures: [failure()] } }

/** Opened, with three attempts that failed the same way. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /previous error/ }))
  },
  args: {
    failures: [
      failure({ occurredAt: Date.UTC(2026, 9, 11, 8, 40, 0) }),
      failure({ occurredAt: Date.UTC(2026, 9, 11, 9, 2, 0) }),
      failure({ occurredAt: Date.UTC(2026, 9, 11, 9, 32, 0) }),
    ],
  },
}
