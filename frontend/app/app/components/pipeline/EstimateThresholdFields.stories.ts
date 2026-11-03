import type { Meta, StoryObj } from '@storybook/vue3'
import EstimateThresholdFields from './EstimateThresholdFields.vue'

// The threshold row of an estimate gate in the pipeline builder: one 0..1 field per axis, and the
// step runs (or the consensus panel convenes) when any axis is met or exceeded. An empty field
// sets no threshold on that axis. `outcome` changes only the tooltip on "run when (any):", so
// there is no story per outcome.
const meta = {
  title: 'Pipeline/Components/EstimateThresholdFields',
  component: EstimateThresholdFields,
  parameters: { width: 'panel' },
  args: { axes: ['complexity', 'risk', 'impact'] as const, outcome: 'step' as const },
} satisfies Meta<typeof EstimateThresholdFields>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { gating: { minComplexity: 0.5, minRisk: 0.7 } } }

/** No thresholds set: every field empty. */
export const AllUnset: Story = { args: { gating: {} } }

/** A gate that exposes one axis: the other fields are not drawn. */
export const SingleAxis: Story = {
  args: { axes: ['risk'] as const, gating: { minRisk: 0.6 } },
}
