import type { Meta, StoryObj } from '@storybook/vue3'
import { step } from '~/stories/pipelineStep.stories.mocks'
import AgentChip from './AgentChip.vue'

// One agent step on a card: the kind's icon and label, with a ring per state. `waiting_decision`
// is the only state that pulses.
const meta = {
  title: 'Board/Components/AgentChip',
  component: AgentChip,
} satisfies Meta<typeof AgentChip>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { step: step({ state: 'working' }) } }

/** Not started: a faint ring and the whole chip dimmed. */
export const Pending: Story = { args: { step: step({ state: 'pending', progress: 0 }) } }

/** Waiting on a human: a warning ring that pulses, and a question mark. */
export const WaitingDecision: Story = {
  args: { step: step({ state: 'waiting_decision', progress: 0.6 }) },
}

export const Done: Story = { args: { step: step({ state: 'done', progress: 1 }) } }

/** The active step on its card: scaled up, whatever its state. */
export const Active: Story = { args: { step: step({ state: 'working' }), active: true } }

/** Small: smaller, with no label under it. */
export const Small: Story = { args: { step: step({ state: 'working' }), size: 'sm' } }

/** A kind this build does not know: the generic "Agent" icon and label. */
export const UnknownKind: Story = {
  args: { step: step({ agentKind: 'acme-security-scanner', state: 'working' }) },
}
