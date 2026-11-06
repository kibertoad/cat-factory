import type { Meta, StoryObj } from '@storybook/vue3'
import { researchView } from '~/stories/research.stories.mocks'
import ResearchCredentialReadiness from './ResearchCredentialReadiness.vue'

// Whether each credential a research definition declares is stored for this board, with what a
// person does to obtain one.
const meta = {
  title: 'Board/Components/ResearchCredentialReadiness',
  component: ResearchCredentialReadiness,
  parameters: { width: 'panel' },
  args: { credentials: researchView.credentials },
} satisfies Meta<typeof ResearchCredentialReadiness>
export default meta

type Story = StoryObj<typeof meta>

/** A vendor login the board has not stored yet. */
export const Missing: Story = {}

/** The same login once it is stored. */
export const Stored: Story = {
  args: { credentials: researchView.credentials.map((c) => ({ ...c, status: 'stored' as const })) },
}

/** A definition that declares no credentials. */
export const None: Story = { args: { credentials: [] } }
