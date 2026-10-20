import type { Meta, StoryObj } from '@storybook/vue3'
import type { Account, BudgetCaps, SpendStatus } from '@cat-factory/contracts'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { spendStatus } from '~/stories/providers.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useUserSettingsStore } from '~/stores/userSettings'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import { useWorkspaceStore } from '~/stores/workspace'
import BudgetSettings from './BudgetSettings.vue'

// The three monthly spend budgets: the board's own limit and currency, the account's ceiling and
// the signed-in user's ceiling. A run stops when any tier is spent. An operator can cap the
// account and user limits; the cap shows under each input, and a limit above it turns the line
// red and turns Save off. Each tier says what it has spent this month when the snapshot carries
// its status. Each story seeds the stores; nothing is loaded.
interface Seed {
  account?: Account | null
  workspaceLimit?: number | null
  userLimit?: number | null
  spend?: { workspace?: SpendStatus; account?: SpendStatus; user?: SpendStatus }
  caps?: BudgetCaps
}

function seeded({ account = orgAccount, workspaceLimit, userLimit, spend = {}, caps }: Seed) {
  return withSeed(() => {
    seedWorkspace()
    const accounts = useAccountsStore()
    accounts.accounts = account ? [account] : []
    accounts.activeAccountId = account?.id ?? null
    const settings = useWorkspaceSettingsStore()
    settings.settings = { ...settings.settings, spendMonthlyLimit: workspaceLimit ?? null }
    const user = useUserSettingsStore()
    user.settings = { ...user.settings, spendMonthlyLimit: userLimit ?? null }
    const workspace = useWorkspaceStore()
    workspace.spend = spend.workspace ?? null
    workspace.accountSpend = spend.account ?? null
    workspace.userSpend = spend.user ?? null
    workspace.budgetCaps = caps ?? null
  })
}

const meta = {
  title: 'Settings/Components/BudgetSettings',
  component: BudgetSettings,
  parameters: { width: 'prose' },
} satisfies Meta<typeof BudgetSettings>
export default meta

type Story = StoryObj<typeof meta>

/** All three limits set, each with this month's spend under it, for an account admin. */
export const Default: Story = {
  decorators: [
    seeded({
      workspaceLimit: 500,
      userLimit: 150,
      spend: {
        workspace: spendStatus(),
        account: spendStatus({ costSpent: 1240.5, costLimit: 2000 }),
        user: spendStatus({ costSpent: 64.2, costLimit: 150 }),
      },
      account: { ...orgAccount, spendMonthlyLimit: 2000 },
    }),
  ],
}

/** No limits and no spend: every input shows its placeholder. */
export const Empty: Story = {
  decorators: [seeded({ account: { ...orgAccount, spendMonthlyLimit: undefined } })],
}

/** The operator caps the account at €5,000 and a user at €300: each cap shows under its input. */
export const HardCaps: Story = {
  decorators: [
    seeded({
      account: { ...orgAccount, spendMonthlyLimit: 2000 },
      userLimit: 150,
      caps: { accountMonthlyLimitMax: 5000, userMonthlyLimitMax: 300, currency: 'EUR' },
    }),
  ],
}

/** The stored account limit is above the cap: the cap line is red and Save is off. */
export const OverCap: Story = {
  decorators: [
    seeded({
      account: { ...orgAccount, spendMonthlyLimit: 8000 },
      caps: { accountMonthlyLimitMax: 5000, userMonthlyLimitMax: null, currency: 'EUR' },
    }),
  ],
}

/** A developer, not an account admin: the account limit is read-only with a hint, and no Save. */
export const NotAccountAdmin: Story = {
  decorators: [
    seeded({
      account: { ...orgAccount, roles: ['developer'], spendMonthlyLimit: 2000 },
      spend: { account: spendStatus({ costSpent: 1240.5, costLimit: 2000 }) },
    }),
  ],
}

/** No active account, as on a deployment without sign-in: there is no account tier. */
export const NoAccount: Story = { decorators: [seeded({ account: null, workspaceLimit: 500 })] }
