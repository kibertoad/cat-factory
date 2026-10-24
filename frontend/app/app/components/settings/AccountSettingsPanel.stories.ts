import type { Meta, StoryObj } from '@storybook/vue3'
import type { Account } from '@cat-factory/contracts'
import { orgAccount, signedInUser } from '~/stories/accounts.stories.mocks'
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
// There are no stories with an account until #2393 is fixed: the viewer is an admin of both
// accounts, the platform alert section on the Team tab gives a select item the value '', Reka's
// SelectItem throws for an empty value, and Storybook's error display covers the window (#2393).

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

/** No active account yet: the window says so, and shows no tabs. */
export const Default: Story = {
  decorators: [opened(null)],
  parameters: { api: [] },
}
