import type { Meta, StoryObj } from '@storybook/vue3'
import OutcomeFilterChips from './OutcomeFilterChips.vue'

// Filter chips over a run's outcomes. Two things are load-bearing in the styling and both are
// easy to lose: a chip whose count is ZERO is dimmed rather than hidden, so the reader can see
// that a category was considered and came back empty; and the error and warning tones are carried
// on the chip, so a failing category is visible before anything is clicked.
const options = [
  { value: 'all', label: 'All', count: 24 },
  { value: 'passed', label: 'Passed', count: 19 },
  { value: 'failed', label: 'Failed', count: 3, tone: 'error' as const },
  { value: 'flaky', label: 'Flaky', count: 2, tone: 'warning' as const },
  { value: 'skipped', label: 'Skipped', count: 0 },
]

// A generic component, so Storybook can neither take it as `component` nor read its props off
// `typeof OutcomeFilterChips`. Instantiated at `string`, it gives the props a caller would pass,
// and the render function carries them.
type OutcomeFilterChipsArgs = Pick<
  Parameters<typeof OutcomeFilterChips<string>>[0],
  'options' | 'modelValue'
>

const meta = {
  title: 'Run telemetry/Components/OutcomeFilterChips',
  render: (args) => ({
    components: { OutcomeFilterChips },
    setup: () => ({ args }),
    template: '<OutcomeFilterChips v-bind="args" />',
  }),
  args: { options, modelValue: 'all' },
} satisfies Meta<OutcomeFilterChipsArgs>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

/** A toned category selected: the active treatment has to beat the tone, not fight it. */
export const FailedSelected: Story = { args: { modelValue: 'failed' } }

/** Everything came back zero. Dimmed, still present, still countable. */
export const AllZero: Story = {
  args: {
    options: options.map((o) => ({ ...o, count: 0 })),
    modelValue: 'all',
  },
}
