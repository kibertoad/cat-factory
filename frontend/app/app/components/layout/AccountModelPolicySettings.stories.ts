import type { Meta, StoryObj } from '@storybook/vue3'
import { getAccountSettingsContract } from '@cat-factory/contracts'
import type { ModelFamilyPolicy } from '@cat-factory/contracts'
import { expect, within } from 'storybook/test'
import { accountSettingsView, orgAccount } from '~/stories/accounts.stories.mocks'
import { apiFailure, apiResponse } from '~/stories/api'
import AccountModelPolicySettings from './AccountModelPolicySettings.vue'

// Which model families the account's boards may run, for account admins: off, a blocklist or an
// allowlist, with the built-in presets for the chosen region and a residency route (Bedrock) that
// lets an otherwise blocked family through. The panel loads the account settings when it mounts,
// so each story answers that read. The families and the bedrock route are the contract's own.
const settingsAre = (modelPolicy?: ModelFamilyPolicy) =>
  apiResponse(getAccountSettingsContract, {
    pathParams: { accountId: orgAccount.id },
    body: { ...accountSettingsView, config: modelPolicy ? { modelPolicy } : {} },
  })

const meta = {
  title: 'Settings/Components/AccountModelPolicySettings',
  component: AccountModelPolicySettings,
  parameters: { width: 'prose' },
  args: { accountId: orgAccount.id },
} satisfies Meta<typeof AccountModelPolicySettings>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A European account that blocks the China-hosted families, unless Bedrock serves them: its two
 * presets, the four blocked families and the route.
 */
export const Default: Story = {
  parameters: {
    api: [
      settingsAre({
        mode: 'blocklist',
        region: 'europe',
        families: ['deepseek', 'qwen', 'kimi', 'glm'],
        trustedProviders: ['bedrock'],
      }),
    ],
  },
}

/** No policy stored: the mode is off, so the family and route lists are hidden. */
export const Off: Story = { parameters: { api: [settingsAre()] } }

/** A US account that allows three families, with no residency route. */
export const Allowlist: Story = {
  parameters: {
    api: [
      settingsAre({
        mode: 'allowlist',
        region: 'usa',
        families: ['claude', 'openai', 'gemini'],
        trustedProviders: [],
      }),
    ],
  },
}

/**
 * The account settings did not load: no editor, a notice that says so, and the save button
 * disabled, because a save replaces the whole account config and would wipe every other setting.
 * The deployment-settings panel beside this one reports the failure itself, so no toast here.
 */
export const Failed: Story = {
  parameters: {
    api: [apiFailure(getAccountSettingsContract, { pathParams: { accountId: orgAccount.id } })],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByTestId('account-model-policy-unloaded')
    await expect(canvas.getByTestId('account-model-policy-save')).toBeDisabled()
    await expect(canvas.queryByRole('combobox')).toBeNull()
  },
}
