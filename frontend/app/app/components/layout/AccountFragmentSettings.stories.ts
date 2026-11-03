import type { Meta, StoryObj } from '@storybook/vue3'
import { accountBoards, accounts, orgAccount } from '~/stories/accounts.stories.mocks'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { fragmentLibraryApi } from '~/stories/fragmentLibraryApi'
import { accountFragments } from '~/stories/fragments.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { documentProbeApi } from '~/stories/shellApi'
import { withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useWorkspaceStore } from '~/stores/workspace'
import AccountFragmentSettings from './AccountFragmentSettings.vue'

// The account's Context fragments tab: the best-practice fragments every board of the account
// inherits. A document fragment is fetched through a board's document connection, so the tab
// picks the board the settings were opened from (Core services), or else the account's first.
// The library loads the account's fragments, the board's document sources and the GitHub
// connection when it opens, so each story answers those reads. The library's other states are in
// `FragmentLibraryManager`'s stories.
function openedFromCoreServices() {
  return withSeed(() => {
    const accountsStore = useAccountsStore()
    accountsStore.accounts = accounts
    accountsStore.activeAccountId = orgAccount.id
    const workspace = useWorkspaceStore()
    workspace.workspaces = accountBoards
    workspace.workspaceId = STORY_WORKSPACE_ID
  })
}

const meta = {
  title: 'Settings/Components/AccountFragmentSettings',
  component: AccountFragmentSettings,
  args: { accountId: orgAccount.id },
  decorators: [openedFromCoreServices()],
  parameters: {
    width: 'prose',
    api: [
      ...fragmentLibraryApi({ accountId: orgAccount.id }, { fragments: accountFragments }),
      ...documentProbeApi(),
      ...githubProbeApi(),
    ],
  },
} satisfies Meta<typeof AccountFragmentSettings>
export default meta

type Story = StoryObj<typeof meta>

/** The account's logging conventions and feature flag rule, and the form that writes another. */
export const Default: Story = {}

/** Nothing written for the account yet. */
export const Empty: Story = {
  parameters: {
    api: [
      ...fragmentLibraryApi({ accountId: orgAccount.id }),
      ...documentProbeApi(),
      ...githubProbeApi(),
    ],
  },
}

/** The library read failed, which the manager reads as the feature being off: a note only. */
export const Unavailable: Story = {
  parameters: {
    api: [
      ...fragmentLibraryApi({ accountId: orgAccount.id }, { available: false }),
      ...documentProbeApi(),
      ...githubProbeApi(),
    ],
  },
}
