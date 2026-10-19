import type { Meta, StoryObj } from '@storybook/vue3'
import OutputBudgetInput from './OutputBudgetInput.vue'

// The output-token ceiling for a step or an agent kind. Empty means inherit, never zero, and the
// placeholder names the inherited value when the caller knows it.
const meta = {
  title: 'Pipeline/Components/OutputBudgetInput',
  component: OutputBudgetInput,
  // At the width the pipeline builder gives it.
  render: (args) => ({
    components: { OutputBudgetInput },
    setup: () => ({ args }),
    template: '<OutputBudgetInput v-bind="args" class="w-28" />',
  }),
} satisfies Meta<typeof OutputBudgetInput>
export default meta

type Story = StoryObj<typeof meta>

/** Not set, and no inherited value known: the generic placeholder. */
export const Default: Story = { args: { modelValue: null } }

/**
 * Not set: the placeholder names the inherited value. At the builder's `w-28` it is clipped to
 * "Inherited (8,19", so the number the field exists to show is cut off.
 */
export const Inheriting: Story = { args: { modelValue: null, inheritedValue: 8192 } }

export const Overridden: Story = { args: { modelValue: 16384, inheritedValue: 8192 } }

export const Disabled: Story = { args: { modelValue: 16384, disabled: true } }
