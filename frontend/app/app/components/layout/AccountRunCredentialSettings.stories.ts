import type { Meta, StoryObj } from '@storybook/vue3'
import { getAccountSettingsContract } from '@cat-factory/contracts'
import { expect, within } from 'storybook/test'
import { accountSettingsView, orgAccount } from '~/stories/accounts.stories.mocks'
import { apiFailure, apiResponse } from '~/stories/api'
import AccountRunCredentialSettings from './AccountRunCredentialSettings.vue'

// The account-wide floor under each board's "a run may use its initiator's personal token"
// switch, for account admins. On, it forbids personal tokens on every board of the account, and
// the hint under it says what that costs. The panel loads the account settings when it mounts,
// so each story answers that read.
const settingsAre = (allowInitiatorPat?: boolean) =>
  apiResponse(getAccountSettingsContract, {
    pathParams: { accountId: orgAccount.id },
    body: {
      ...accountSettingsView,
      config: allowInitiatorPat === undefined ? {} : { allowInitiatorPat },
    },
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
export const Default: Story = { parameters: { api: [settingsAre()] } }

/** Personal tokens forbidden: the switch is on, with the warning about what it costs. */
export const Forbidden: Story = { parameters: { api: [settingsAre(false)] } }

/**
 * The account settings did not load: no switch, a notice that says so, and the save button
 * disabled, because a save replaces the whole account config and would wipe every other setting.
 * The deployment-settings panel beside this one reports the failure itself, so no toast here.
 */
export const Failed: Story = {
  parameters: {
    api: [apiFailure(getAccountSettingsContract, { pathParams: { accountId: orgAccount.id } })],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByTestId('account-run-credential-unloaded')
    await expect(canvas.getByTestId('account-run-credential-save')).toBeDisabled()
    await expect(canvas.queryByTestId('account-forbid-initiator-pat')).toBeNull()
  },
}
