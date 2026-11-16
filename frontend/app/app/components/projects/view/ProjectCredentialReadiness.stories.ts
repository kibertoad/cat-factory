import type { Meta, StoryObj } from '@storybook/vue3'
import { researchBoardView } from '~/stories/research.stories.mocks'
import ProjectCredentialReadiness from './ProjectCredentialReadiness.vue'

// Whether each credential a project's definition declares is stored for this board, with what a
// person does to obtain one.
const meta = {
  title: 'Board/Components/ProjectCredentialReadiness',
  component: ProjectCredentialReadiness,
  parameters: { width: 'panel' },
  args: { credentials: researchBoardView.credentials },
} satisfies Meta<typeof ProjectCredentialReadiness>
export default meta

type Story = StoryObj<typeof meta>

/** A vendor login the board has not stored yet. */
export const Missing: Story = {}

/** The same login once it is stored. */
export const Stored: Story = {
  args: {
    credentials: researchBoardView.credentials.map((c) => ({ ...c, status: 'stored' as const })),
  },
}

/** A definition that declares no credentials. */
export const None: Story = { args: { credentials: [] } }
