import type { Meta, StoryObj } from '@storybook/vue3'
import type { Account } from '@cat-factory/contracts'
import { orgAccount, signedInUser } from '~/stories/accounts.stories.mocks'
import { accountTeamApi } from '~/stories/accountsApi'
import { infrastructureCapabilities } from '~/stories/infra.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useAuthStore } from '~/stores/auth'
import AccountTeamSettings from './AccountTeamSettings.vue'

// The account's Team tab. For an organisation: the members and their roles, the invitations,
// and the sender for the account's e-mail. For an admin, below them: the account's API keys
// (vendors, then gateways), the deployment secrets, the model policy, the platform alert
// thresholds, the run credential floor and, in the advanced tier, the audit log. A personal
// account gets a way to create an organisation in place of the roster. The tab loads the e-mail
// sender and the roster, and each section loads its own data, so each story answers those reads.
// Each section's own states are in its own stories.
//
// The answers are `accountTeamApi`, shared with the Account settings window. There are no admin
// stories until #2393 is fixed: the platform alert section gives its window select an item with
// the value '', Reka's SelectItem throws for an empty value, and Storybook's error display covers
// the tab for every admin viewer (#2393). The personal account's viewer is an admin too.

/** `account` active, with the viewer signed in on a deployment that can govern model families. */
function active(account: Account) {
  return withSeed(() => {
    const accounts = useAccountsStore()
    accounts.accounts = [account]
    accounts.activeAccountId = account.id
    const auth = useAuthStore()
    auth.user = signedInUser
    auth.infrastructure = infrastructureCapabilities()
  })
}

const meta = {
  title: 'Settings/Components/AccountTeamSettings',
  component: AccountTeamSettings,
  args: { accountId: orgAccount.id },
  decorators: [active(orgAccount)],
  parameters: { width: 'prose', api: accountTeamApi() },
} satisfies Meta<typeof AccountTeamSettings>
export default meta

type Story = StoryObj<typeof meta>

/** A developer of Acme: the roles as text, no way to end a session, and no admin section. */
export const Default: Story = {
  decorators: [active({ ...orgAccount, roles: ['developer'] })],
}
