import type { Meta, StoryObj } from '@storybook/vue3'
import type { Account } from '@cat-factory/contracts'
import { orgAccount, personalAccount, signedInUser } from '~/stories/accounts.stories.mocks'
import { accountTeamApi } from '~/stories/accountsApi'
import { infrastructureCapabilities } from '~/stories/infra.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useAuthStore } from '~/stores/auth'
import { useUiStore } from '~/stores/ui'
import AccountSettingsPanel from './AccountSettingsPanel.vue'

// The Account settings window: the active account's own configuration, apart from a board's. Five
// tabs: Team, the account's prompt fragments, its skills, its foundational services and its risk
// policies. It opens on Team, and each tab loads its own data when it shows, so the stories answer
// the Team tab's reads (`accountTeamApi`). The other tabs are the `AccountFragmentSettings`,
// `AccountSkillSettings`, `AccountFoundationalSettings` and `AccountRiskPolicySettings` stories,
// and the Team tab's own states are the `AccountTeamSettings` stories.
//
// The viewer is an admin of both accounts, so in the Default and PersonalAccount stories
// Storybook's error display covers the window: the platform alert section on the Team tab gives a
// select item the value '', and Reka's SelectItem throws for an empty value. The window renders
// in full under the display.

/**
 * The window opened on `account`, by a signed-in viewer on a deployment that can govern model
 * families.
 */
function opened(account: Account | null) {
  return withSeed(() => {
    const accounts = useAccountsStore()
    accounts.accounts = account ? [account] : []
    accounts.activeAccountId = account?.id ?? null
    const auth = useAuthStore()
    auth.user = signedInUser
    auth.infrastructure = infrastructureCapabilities()
    useUiStore().openAccountSettings()
  })
}

const meta = {
  title: 'Settings/Pages/AccountSettingsPanel',
  component: AccountSettingsPanel,
  decorators: [opened(orgAccount)],
  parameters: { api: accountTeamApi() },
} satisfies Meta<typeof AccountSettingsPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Acme, with the viewer an admin: the five tabs, and the Team tab with every admin section. */
export const Default: Story = {}

/** The viewer's personal account: the Team tab offers to create an organisation. */
export const PersonalAccount: Story = {
  decorators: [opened(personalAccount)],
  parameters: { api: accountTeamApi(personalAccount, { connection: null, configured: true }) },
}

/** No active account yet: the window says so, and shows no tabs. */
export const NoAccount: Story = {
  decorators: [opened(null)],
  parameters: { api: [] },
}
