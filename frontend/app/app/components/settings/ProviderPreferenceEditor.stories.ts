import type { Meta, StoryObj } from '@storybook/vue3'
import type { ModelFlavor } from '@cat-factory/contracts'
import { fn } from 'storybook/test'
import ProviderPreferenceEditor from './ProviderPreferenceEditor.vue'

// The route order of one model preset: which of a model's five routes its runs prefer, most
// preferred first. An order only moves routes, it never removes one. No stored order means the
// shipped default, and a move back to that default clears the stored order. Two notes can show:
// a connected subscription still wins over an order that does not put it first, and on a preset
// that is not the default, the model list's route badges follow the default preset's order.
// A full permutation, as the editor stores it: Bedrock moved up from second place.
const bedrockFirst: ModelFlavor[] = [
  'bedrock',
  'direct',
  'openrouter',
  'cloudflare',
  'subscription',
]

const meta = {
  title: 'Settings/Components/ProviderPreferenceEditor',
  component: ProviderPreferenceEditor,
  parameters: { width: 'prose' },
  args: { modelValue: undefined, 'onUpdate:modelValue': fn() },
} satisfies Meta<typeof ProviderPreferenceEditor>
export default meta

type Story = StoryObj<typeof meta>

/** No stored order: the five routes in the shipped order, and no reset. */
export const Default: Story = {}

/** A stored order that puts AWS Bedrock first: the custom hint and Reset. */
export const CustomOrder: Story = {
  args: { modelValue: bedrockFirst, isDefaultPreset: true },
}

/** The same order on a workspace with a subscription connected: the warning that it still wins. */
export const SubscriptionWins: Story = {
  args: { modelValue: bedrockFirst, hasSubscription: true, isDefaultPreset: true },
}

/** A custom order on a preset that is not the default: the note about the route badges. */
export const NotDefaultPreset: Story = {
  args: { modelValue: bedrockFirst, isDefaultPreset: false },
}
