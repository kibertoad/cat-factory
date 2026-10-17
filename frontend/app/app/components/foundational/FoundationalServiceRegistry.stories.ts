import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { accountServices, workspaceServices } from '~/stories/foundational.stories.mocks'
import { seedFoundationalCatalog, withSeed } from '~/stories/withStores'
import FoundationalServiceRegistry from './FoundationalServiceRegistry.vue'

// The services one tier registers itself (not the merged catalog), and the form that adds or
// edits one. A service's id is what an architect names, so it is fixed once registered; a
// contract list, once touched, replaces the stored set. A service synced from a repository says
// so and has no edit button, because its next sync would undo the edit. The stories seed the
// account's own list, as its manager would load it.
const meta = {
  title: 'Settings/Components/FoundationalServiceRegistry',
  component: FoundationalServiceRegistry,
  args: { kind: 'account', ownerId: orgAccount.id },
  decorators: [
    withSeed(() => seedFoundationalCatalog({ services: accountServices }, orgAccount.id)),
  ],
  parameters: { width: 'prose' },
} satisfies Meta<typeof FoundationalServiceRegistry>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The account's two: file storage, uploaded, with edit and delete; notifications, synced from a
 * repository, with delete only.
 */
export const Default: Story = {}

/** The board's own service, at the workspace tier. */
export const Workspace: Story = {
  args: { kind: 'workspace', ownerId: STORY_WORKSPACE_ID },
  decorators: [withSeed(() => seedFoundationalCatalog({ services: workspaceServices }))],
}

/** Nothing registered at this tier. */
export const Empty: Story = {
  decorators: [withSeed(() => seedFoundationalCatalog({ services: [] }, orgAccount.id))],
}

/**
 * Register a service: the id field and the details. The contract hint says untouched keeps the
 * stored documents, though a new service has none.
 */
export const Creating: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Register a service' }))
    await screen.findByText('Register a foundational service')
  },
}

/** Edit file storage: the id is fixed, and the contract list says the stored set is kept. */
export const Editing: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByText('Edit foundational service')
  },
}
