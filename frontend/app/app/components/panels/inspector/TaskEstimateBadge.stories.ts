import type { Meta, StoryObj } from '@storybook/vue3'
import { block, estimate } from '~/stories/block.stories.mocks'
import TaskEstimateBadge from './TaskEstimateBadge.vue'

// A task's complexity, risk and impact as three bars, under a line saying whether the reading is
// a forecast or a measurement. A bar is info below 33%, warning from 33% and error from 66%. A
// block with no estimate renders nothing, so there is no story for it.
const meta = {
  title: 'Inspector/Components/TaskEstimateBadge',
  component: TaskEstimateBadge,
  parameters: { width: 'panel' },
} satisfies Meta<typeof TaskEstimateBadge>
export default meta

type Story = StoryObj<typeof meta>

/** A forecast. */
export const Default: Story = { args: { block: block({ estimate: estimate() }) } }

/**
 * A measurement that replaced the forecast. It names what it replaced, and shows the old value
 * beside each axis that moved. Impact did not move, so it has none.
 */
export const Measured: Story = {
  args: {
    block: block({
      estimate: estimate({
        complexity: 0.9,
        risk: 0.8,
        basis: 'observed',
        rationale: 'The change touched both runtimes, which the forecast did not expect.',
        supersedes: {
          complexity: 0.6,
          risk: 0.4,
          impact: 0.7,
          basis: 'predicted',
          createdAt: Date.UTC(2026, 9, 10, 9, 0, 0),
        },
      }),
    }),
  },
}

/** Every axis at 100%. */
export const AllHigh: Story = {
  args: {
    block: block({
      estimate: estimate({
        complexity: 1,
        risk: 1,
        impact: 1,
        rationale: 'Rewrites the session contract across both runtimes.',
      }),
    }),
  },
}

/** Every axis at 5%: a short stub of a bar. */
export const AllLow: Story = {
  args: {
    block: block({
      estimate: estimate({
        complexity: 0.05,
        risk: 0.05,
        impact: 0.05,
        rationale: 'A copy change.',
      }),
    }),
  },
}
