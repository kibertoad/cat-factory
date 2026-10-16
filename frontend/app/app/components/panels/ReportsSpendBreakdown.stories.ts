import type { Meta, StoryObj } from '@storybook/vue3'
import type { ReportSpendRow } from '~/types/execution'
import ReportsSpendBreakdown from './ReportsSpendBreakdown.vue'

// One spend breakdown from the reports panel: a bar per slice, scaled against the heaviest slice
// in the list. Metered spend and the subscription equivalent are separate segments and are never
// added. When the projection capped the list, a footer says how many slices were left out.
const row = (key: string, metered: number, calls: number, subscription = 0): ReportSpendRow => ({
  key,
  label: key,
  inputTokens: calls * 4200,
  outputTokens: calls * 900,
  calls,
  meteredCost: metered,
  subscriptionCost: subscription,
})

const meta = {
  title: 'Run telemetry/Components/ReportsSpendBreakdown',
  component: ReportsSpendBreakdown,
  parameters: { width: 'panel' },
  args: {
    currency: 'USD',
    testId: 'story-spend',
    labelOf: (r: ReportSpendRow) => r.label ?? r.key,
  },
} satisfies Meta<typeof ReportsSpendBreakdown>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    rows: [
      row('coder', 18.42, 310),
      row('pr-reviewer', 9.15, 164),
      row('architect', 3.88, 52),
      row('tester', 0.74, 19),
    ],
  },
}

/** Capped: the two heaviest slices are shown and three more are left out. */
export const Capped: Story = {
  args: {
    rows: [row('coder', 18.42, 310), row('pr-reviewer', 9.15, 164)],
    cap: { dimension: 'agentKind', returned: 2, omitted: 3 },
  },
}

/** Subscription usage: zero metered spend, with the equivalent API cost beside it. */
export const Subscription: Story = {
  args: { rows: [row('coder', 0, 310, 18.42), row('pr-reviewer', 0, 164, 9.15)] },
}

/** One slice, so its bar is full width. */
export const SingleRow: Story = { args: { rows: [row('coder', 18.42, 310)] } }

/** Nothing recorded in the window: the empty state. */
export const Empty: Story = { args: { rows: [] } }
