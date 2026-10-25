import type { Meta, StoryObj } from '@storybook/vue3'
import { getAccountSettingsContract } from '@cat-factory/contracts'
import { expect, within } from 'storybook/test'
import { accountSettingsView, orgAccount } from '~/stories/accounts.stories.mocks'
import { apiFailure } from '~/stories/api'
import { withSeed } from '~/stories/withStores'
import { useAccountSettingsStore } from '~/stores/accountSettings'
import AccountRunCredentialSettings from './AccountRunCredentialSettings.vue'

// The account-wide floor under each board's "a run may use its initiator's personal token"
// switch, for account admins. On, it forbids personal tokens on every board of the account, and
// the hint under it says what that costs. Each story seeds the account settings, so the panel
// does not load them.
const seeded = (allowInitiatorPat?: boolean) =>
  withSeed(() => {
    const store = useAccountSettingsStore()
    store.view = {
      ...accountSettingsView,
      config: allowInitiatorPat === undefined ? {} : { allowInitiatorPat },
    }
    store.available = true
  })

const meta = {
  title: 'Settings/Components/AccountRunCredentialSettings',
  component: AccountRunCredentialSettings,
  parameters: { width: 'prose' },
  args: { accountId: orgAccount.id },
} satisfies Meta<typeof AccountRunCredentialSettings>
export default meta

type Story = StoryObj<typeof meta>

/** Not set: the switch is off, with the off hint. */
export const Default: Story = { decorators: [seeded()] }

/** Personal tokens forbidden: the switch is on, with the warning about what it costs. */
export const Forbidden: Story = { decorators: [seeded(false)] }

/**
 * The account settings did not load: the panel says so and the save button is disabled, because a
 * save replaces the whole account config and would wipe every other setting.
 */
export const LoadFailed: Story = {
  parameters: {
    api: [apiFailure(getAccountSettingsContract, { pathParams: { accountId: orgAccount.id } })],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByTestId('account-run-credential-unloaded')
    await expect(canvas.getByTestId('account-run-credential-save')).toBeDisabled()
  },
}
