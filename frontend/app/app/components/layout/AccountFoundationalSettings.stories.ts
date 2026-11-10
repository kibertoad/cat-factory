import type { Meta, StoryObj } from '@storybook/vue3'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { foundationalApi } from '~/stories/foundationalApi'
import { accountServices, foundationalSources } from '~/stories/foundational.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import AccountFoundationalSettings from './AccountFoundationalSettings.vue'

// The account's foundational services tab: the services the whole organisation runs, which every
// board in the account inherits, and the repositories they sync from. An account has no merged
// catalog and no portal, so the manager opens on the account's own list. It loads the account's
// catalog and probes GitHub for the board the settings were opened from, so each story answers
// those reads.
const owner = { accountId: orgAccount.id }

const meta = {
  title: 'Settings/Components/AccountFoundationalSettings',
  component: AccountFoundationalSettings,
  args: { accountId: orgAccount.id },
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: [
      ...foundationalApi(owner, { services: accountServices, sources: foundationalSources }),
      ...githubProbeApi(),
    ],
  },
} satisfies Meta<typeof AccountFoundationalSettings>
export default meta

type Story = StoryObj<typeof meta>

/** The account's file storage and notifications, and Register a service under them. */
export const Default: Story = {}

/** Nothing registered yet. */
export const Empty: Story = {
  parameters: { api: [...foundationalApi(owner), ...githubProbeApi()] },
}

/** The deployment has not enabled the catalog (a 503): a note only. */
export const Unavailable: Story = {
  parameters: { api: [...foundationalApi(owner, { available: false }), ...githubProbeApi()] },
}
