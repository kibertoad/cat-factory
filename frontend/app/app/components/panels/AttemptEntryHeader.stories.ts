import type { Meta, StoryObj } from '@storybook/vue3'
import AttemptEntryHeader from './AttemptEntryHeader.vue'

// The header row of one attempt in a timeline: a label, an outcome badge and a date. Two surfaces
// use it, the tester's fixer rounds (with an icon, date only) and a polling gate's helper
// attempts (no icon, date and time). A failed outcome turns the badge red.
const meta = {
  title: 'Pipeline/Components/AttemptEntryHeader',
  component: AttemptEntryHeader,
  parameters: { width: 'panel' },
  args: { at: Date.UTC(2026, 9, 11, 9, 32, 0) },
} satisfies Meta<typeof AttemptEntryHeader>
export default meta

type Story = StoryObj<typeof meta>

/** A tester fixer round that completed. */
export const Default: Story = {
  args: {
    label: 'Attempt 2',
    outcome: 'completed',
    outcomeLabel: 'Completed',
    icon: 'i-lucide-wrench',
    iconClass: 'text-app-warning-300',
  },
}

/** A tester fixer round that failed. */
export const Failed: Story = {
  args: {
    label: 'Attempt 1',
    outcome: 'failed',
    outcomeLabel: 'Failed',
    icon: 'i-lucide-circle-x',
    iconClass: 'text-app-error-400',
  },
}

/** A gate helper attempt, as the gate result window draws it. */
export const GateAttempt: Story = {
  args: { label: 'Attempt 2', outcome: 'completed', outcomeLabel: 'Completed', dateFormat: 'long' },
}

/** No timestamp: the date is left out. */
export const NoTimestamp: Story = {
  args: { label: 'Attempt 3', outcome: 'completed', outcomeLabel: 'Completed', at: null },
}
