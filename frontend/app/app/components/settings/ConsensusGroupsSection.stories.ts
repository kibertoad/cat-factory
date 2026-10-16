import type { Meta, StoryObj } from '@storybook/vue3'
import type { ConsensusGroup } from '@cat-factory/contracts'
import { consensusGroups as library } from '~/stories/consensus.stories.mocks'
import { screen, userEvent, within } from 'storybook/test'
import { claudeOnlyCatalog, modelOption, vendorCredential } from '~/stories/providers.stories.mocks'
import { seedModelCatalog, seedUiMode, withSeed } from '~/stories/withStores'
import { useConsensusGroupsStore } from '~/stores/consensusGroups'
import { useVendorCredentialsStore } from '~/stores/vendorCredentials'
import ConsensusGroupsSection from './ConsensusGroupsSection.vue'

// The board's library of consensus groups: review panels of several models (each participant a
// role, a framing and a model), the strategy that runs them, the model that writes the verdict,
// and the estimate a task must reach to earn the panel. A pipeline step names a set of groups and
// the engine runs the most demanding one the task clears. The section is advanced-tier authoring,
// shown in basic mode only once the library holds a group, so an empty library in basic mode
// renders nothing and has no story. Each story seeds the library, the
// model catalog and a Claude subscription, as the snapshot carries them.
function seeded(groups: ConsensusGroup[], mode: 'basic' | 'advanced' = 'advanced') {
  return withSeed(() => {
    seedModelCatalog([modelOption(), claudeOnlyCatalog[2]!])
    useVendorCredentialsStore().credentials = [vendorCredential()]
    useConsensusGroupsStore().hydrate(groups)
    seedUiMode(mode)
  })
}

const meta = {
  title: 'Settings/Components/ConsensusGroupsSection',
  component: ConsensusGroupsSection,
  decorators: [seeded(library)],
  parameters: { width: 'prose' },
} satisfies Meta<typeof ConsensusGroupsSection>
export default meta

type Story = StoryObj<typeof meta>

/** Two groups: one gated at 70% risk, and a debate that always runs. */
export const Default: Story = {}

/** An empty library, in advanced mode. */
export const Empty: Story = { decorators: [seeded([])] }

/** New group: two starting participants on the step's model, gated at 70% risk. */
export const Creating: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await screen.findByTestId('consensus-group-new'))
    await within(canvasElement).findByTestId('consensus-group-save')
  },
}

/** Gated with no threshold left: the warning, and Save is off. */
export const GatingIncomplete: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await screen.findByTestId('consensus-group-new'))
    await userEvent.clear(await screen.findByDisplayValue('0.7'))
    await within(canvasElement).findByText('Set at least one threshold, or turn the gate off.')
  },
}

/** Editing the debate: its three participants, the synthesizer and the rounds field. */
export const DebateRounds: Story = {
  play: async ({ canvasElement }) => {
    const [, debateEdit] = await screen.findAllByRole('button', { name: 'Edit group' })
    await userEvent.click(debateEdit!)
    await within(canvasElement).findByText('Rounds')
  },
}
