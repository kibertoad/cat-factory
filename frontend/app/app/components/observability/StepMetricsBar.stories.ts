import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { stepMetrics } from '~/stories/observability.stories.mocks'
import StepMetricsBar from './StepMetricsBar.vue'

// One step's LLM calls at a glance: the call count, total input and output tokens, the cost, the
// split of input into fresh and cached tokens, how close the longest reply came to the output
// limit, and how much of the time was transport. A step's billing decides whether the cost reads
// as money spent or as an illustrative price.
const meta = {
  title: 'Run telemetry/Components/StepMetricsBar',
  component: StepMetricsBar,
  parameters: { width: 'panel' },
  args: { metrics: stepMetrics(), billing: 'metered', onInspect: fn() },
} satisfies Meta<typeof StepMetricsBar>
export default meta

type Story = StoryObj<typeof meta>

/** A metered step: the cost, the cache breakdown, the headroom bar and the transport split. */
export const Default: Story = {}

/** A step on a subscription: the cost is marked as approximate and as a subscription. */
export const Subscription: Story = { args: { billing: 'subscription' } }

/** No price for the model: the amount is left out, not shown as zero. */
export const NoCost: Story = { args: { metrics: stepMetrics({ costEstimate: null }) } }

/** Two replies hit the output limit: the headroom bar turns red, with the truncation line. */
export const Truncated: Story = {
  args: { metrics: stepMetrics({ peakCompletionTokens: 32_000, truncatedCalls: 2 }) },
}

/** Failed and warned calls: the two badges in the header line. */
export const ErrorsAndWarnings: Story = {
  args: { metrics: stepMetrics({ errors: 3, warnings: 5 }) },
}

/** As the step surfaces show it: the bar is a button, with a chevron, that opens the calls. */
export const Clickable: Story = { args: { clickable: true } }
