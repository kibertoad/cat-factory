import type { Meta, StoryObj } from '@storybook/vue3'
import { getAccountSettingsContract } from '@cat-factory/contracts'
import type { ModelFamilyPolicy } from '@cat-factory/contracts'
import { expect, within } from 'storybook/test'
import { accountSettingsView, orgAccount } from '~/stories/accounts.stories.mocks'
import { apiFailure } from '~/stories/api'
import { withSeed } from '~/stories/withStores'
import { useAccountSettingsStore } from '~/stores/accountSettings'
import AccountModelPolicySettings from './AccountModelPolicySettings.vue'

// Which model families the account's boards may run, for account admins: off, a blocklist or an
// allowlist, with the built-in presets for the chosen region and a residency route (Bedrock) that
// lets an otherwise blocked family through. Each story seeds the account settings, so the panel
// does not load them. The families and the bedrock route are the contract's own.
const seeded = (modelPolicy?: ModelFamilyPolicy) =>
  withSeed(() => {
    const store = useAccountSettingsStore()
    store.view = { ...accountSettingsView, config: modelPolicy ? { modelPolicy } : {} }
    store.available = true
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
  decorators: [
    seeded({
      mode: 'blocklist',
      region: 'europe',
      families: ['deepseek', 'qwen', 'kimi', 'glm'],
      trustedProviders: ['bedrock'],
    }),
  ],
}

/** No policy stored: the mode is off, so the family and route lists are hidden. */
export const Off: Story = { decorators: [seeded()] }

/** A US account that allows three families, with no residency route. */
export const Allowlist: Story = {
  decorators: [
    seeded({
      mode: 'allowlist',
      region: 'usa',
      families: ['claude', 'openai', 'gemini'],
      trustedProviders: [],
    }),
  ],
}

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
    await canvas.findByTestId('account-model-policy-unloaded')
    await expect(canvas.getByTestId('account-model-policy-save')).toBeDisabled()
  },
}
