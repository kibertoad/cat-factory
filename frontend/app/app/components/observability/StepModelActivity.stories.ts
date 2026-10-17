import type { Meta, StoryObj } from '@storybook/vue3'
import { stepMetrics } from '~/stories/observability.stories.mocks'
import StepModelActivity from './StepModelActivity.vue'

// The model activity section of a step: a heading with a link to every call of the run, and the
// step's metrics bar, which opens the same panel. It shows whatever of the two it has.
const meta = {
  title: 'Run telemetry/Components/StepModelActivity',
  component: StepModelActivity,
  parameters: { width: 'panel' },
  args: { metrics: stepMetrics(), billing: 'metered', instanceId: 'exec_login' },
} satisfies Meta<typeof StepModelActivity>
export default meta

type Story = StoryObj<typeof meta>

/** Calls recorded and a run: the link and the bar. */
export const Default: Story = {}

/** A run with no recorded calls for this step: the heading and its link only. */
export const LinkOnly: Story = { args: { metrics: null } }

/** Calls with no run id: the bar, with no link. */
export const BarOnly: Story = { args: { instanceId: undefined } }
