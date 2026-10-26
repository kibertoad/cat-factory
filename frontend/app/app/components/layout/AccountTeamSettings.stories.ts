import type { Meta, StoryObj } from '@storybook/vue3'
import type { Account } from '@cat-factory/contracts'
import { expect, screen } from 'storybook/test'
import type { AuthUser } from '~/types/domain'
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
// The answers are `accountTeamApi`, shared with the Account settings window.

/** Tomás, a developer on the shared roster: the viewer whose row says what `account.roles` says. */
const developerUser: AuthUser = {
  id: 'usr_tomas',
  login: 'truiz',
  name: 'Tomás Ruiz',
  avatarUrl: null,
  email: 'tomas@acme.dev',
}

/** `account` active, with `user` signed in on a deployment that can govern model families. */
function active(account: Account, user: AuthUser = signedInUser) {
  return withSeed(() => {
    const accounts = useAccountsStore()
    accounts.accounts = [account]
    accounts.activeAccountId = account.id
    const auth = useAuthStore()
    auth.user = user
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

/**
 * Tomás, a developer of Acme: the roles as text, no way to end a session, and no admin section.
 * He sees the invitations, under a heading that does not offer to invite, and the sender, but
 * cannot invite, revoke or disconnect: each is an account-admin write the backend refuses him.
 */
export const Default: Story = {
  decorators: [active({ ...orgAccount, roles: ['developer'] }, developerUser)],
  play: async () => {
    await screen.findByText('lena@acme.dev')
    await screen.findByRole('heading', { name: 'Invitations' })
    await screen.findByText('cat-factory@acme.dev', { exact: false })
    await expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
    await expect(screen.queryByRole('button', { name: 'Revoke invitation' })).toBeNull()
    await expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  },
}

/** The same developer with no sender connected: a line saying so, not the admin's connect form. */
export const NoSenderForDeveloper: Story = {
  decorators: [active({ ...orgAccount, roles: ['developer'] }, developerUser)],
  parameters: { api: accountTeamApi({ connection: null, configured: true }) },
  play: async () => {
    await screen.findByText('No email sender is connected. An account admin can connect one.')
    await expect(screen.queryByRole('button', { name: 'Connect email sender' })).toBeNull()
  },
}

/** Maya, an admin of Acme: the roster and, below it, every admin section of the account. */
export const Admin: Story = {}
