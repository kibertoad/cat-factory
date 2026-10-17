import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent, within } from 'storybook/test'
import { withSeed } from '~/stories/withStores'
import { useAgentTierStore } from '~/stores/agentTier'
import AgentTierSelect from './AgentTierSelect.vue'

// How deep into the agent catalog the pipeline builder's palette and a model preset's override
// list look. The tiers add up: basic, then intermediate, then advanced with every kind. The line
// under it says how many kinds the level hides; the caller counts them, so the number here is
// made up.
const meta = {
  title: 'Pipeline/Components/AgentTierSelect',
  component: AgentTierSelect,
  parameters: { width: 'narrow' },
  args: { hiddenCount: 23 },
} satisfies Meta<typeof AgentTierSelect>
export default meta

type Story = StoryObj<typeof meta>

/** Basic, holding back 23 kinds. */
export const Default: Story = {}

/** Advanced shows the whole catalog, so nothing is hidden. */
export const Advanced: Story = {
  args: { hiddenCount: 0 },
  decorators: [withSeed(() => useAgentTierStore().setTier('advanced'))],
}

/** The three tiers with what each adds, and a check on the current one. */
export const Open: Story = {
  render: (args) => ({
    components: { AgentTierSelect },
    setup: () => ({ args }),
    template: '<div class="pb-60"><AgentTierSelect v-bind="args" /></div>',
  }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button'))
    await screen.findByText('Shows every agent, including the specialist ones.')
  },
}
