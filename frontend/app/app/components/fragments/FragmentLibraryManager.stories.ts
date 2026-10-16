import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { fragmentLibraryApi } from '~/stories/fragmentLibraryApi'
import {
  accountFragments,
  handbookSource,
  layeredCatalog,
  platformStandardsSource,
  workspaceFragments,
} from '~/stories/fragments.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { documentProbeApi } from '~/stories/shellApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useFragmentLibraryStore } from '~/stores/fragmentLibrary'
import FragmentLibraryManager from './FragmentLibraryManager.vue'

// The prompt-fragment library of one owner: a board, or an account. A board's opens on the
// catalog its agents are selected from (the built-ins, the account's and the board's own,
// merged); then the fragments written here, the ones that follow a document, and the repositories
// of written guidelines. The manager loads the owner's library, the document sources and the
// GitHub connection when it opens, so each story answers those reads. The tabs are clicked, as a
// person does. The Changes badge comes from a status check the person ran earlier, so the Sources
// story seeds its result.
const board = [
  ...fragmentLibraryApi('workspace', {
    fragments: workspaceFragments,
    sources: [handbookSource, platformStandardsSource],
    resolved: layeredCatalog,
  }),
  ...documentProbeApi(),
  ...githubProbeApi(),
]

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }))
}

const meta = {
  title: 'Settings/Components/FragmentLibraryManager',
  component: FragmentLibraryManager,
  args: { kind: 'workspace', ownerId: STORY_WORKSPACE_ID, showCatalog: true },
  decorators: [withSeed(seedWorkspace)],
  parameters: { width: 'prose', api: board },
} satisfies Meta<typeof FragmentLibraryManager>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The board's merged catalog: four built-ins, the account's two and the board's three, each with
 * its tier, and the Confluence page marked as followed live.
 */
export const Default: Story = {}

/** The library read failed, which the manager reads as the feature being off: a note only. */
export const Unavailable: Story = {
  parameters: {
    api: [
      ...fragmentLibraryApi('workspace', { available: false }),
      ...documentProbeApi(),
      ...githubProbeApi(),
    ],
  },
}

/**
 * The fragments of this board: one written here, which can be edited, one synced from a
 * repository, which cannot, and the form that writes a new one.
 */
export const Authored: Story = {
  play: () => openTab('This board'),
}

/** Nothing written on this board yet. */
export const AuthoredEmpty: Story = {
  parameters: {
    api: [...fragmentLibraryApi('workspace'), ...documentProbeApi(), ...githubProbeApi()],
  },
  play: () => openTab('This board'),
}

/**
 * The fragments that follow a document, and Confluence picked to link another: the page field,
 * and the line that says what is missing.
 */
export const Documents: Story = {
  play: async () => {
    await openTab('Documents')
    await openTab('Confluence')
  },
}

/** No document source connected: the link form says to connect one first. */
export const DocumentsNoSource: Story = {
  parameters: {
    api: [
      ...fragmentLibraryApi('workspace', { fragments: workspaceFragments }),
      ...documentProbeApi({ connections: [] }),
      ...githubProbeApi(),
    ],
  },
  play: () => openTab('Documents'),
}

/**
 * The linked repositories: the handbook, with changes upstream since its last sync, and the
 * platform's standards, not synced yet. The form searches the repositories GitHub can reach.
 */
export const Sources: Story = {
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useFragmentLibraryStore().sourceChanges = { [handbookSource.id]: true }
    }),
  ],
  play: () => openTab('Repo sources'),
}

/**
 * The account's library opened with no board to fetch a document through: the account's two
 * fragments, no catalog tab, and the document form that says to create a board first.
 */
export const AccountScope: Story = {
  args: { kind: 'account', ownerId: orgAccount.id, showCatalog: false },
  parameters: {
    api: [
      ...fragmentLibraryApi({ accountId: orgAccount.id }, { fragments: accountFragments }),
      ...documentProbeApi(),
      ...githubProbeApi(),
    ],
  },
  play: () => openTab('Documents'),
}
