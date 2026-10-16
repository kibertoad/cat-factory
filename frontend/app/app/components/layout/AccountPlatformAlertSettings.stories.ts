import type { Meta, StoryObj } from '@storybook/vue3'
import type { PlatformAlertSettings } from '@cat-factory/contracts'
import { getAccountSettingsContract } from '@cat-factory/contracts'
import { apiFailure } from '~/stories/api'
import { accountSettingsView, orgAccount } from '~/stories/accounts.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useAccountSettingsStore } from '~/stores/accountSettings'
import AccountPlatformAlertSettings from './AccountPlatformAlertSettings.vue'

// The account's overrides for the platform health alerts, for account admins: mute them, pick the
// window they are judged over, and set the ceilings. A blank field keeps the deployment's
// default, and zero is a real value. The per-kind failure rules have their own stories. Each
// story seeds the account settings, except NotLoaded, which answers the load with a failure.
//
// Every story here shows Storybook's error display today: the window select's inherit item has
// the value '', and Reka's SelectItem throws for an empty value, so the panel does not render.
const seeded = (platformAlerts?: PlatformAlertSettings) =>
  withSeed(() => {
    const store = useAccountSettingsStore()
    store.view = { ...accountSettingsView, config: platformAlerts ? { platformAlerts } : {} }
    store.available = true
  })

const meta = {
  title: 'Settings/Components/AccountPlatformAlertSettings',
  component: AccountPlatformAlertSettings,
  parameters: { width: 'prose' },
  args: { accountId: orgAccount.id },
} satisfies Meta<typeof AccountPlatformAlertSettings>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A 24-hour window, a 20% failure ceiling, a 45-minute p99 (stored in milliseconds, shown in
 * minutes), a backlog of 40, and one per-kind rule. Reset all shows, because there are overrides.
 */
export const Default: Story = {
  decorators: [
    seeded({
      window: '24h',
      thresholds: {
        maxFailureRate: 0.2,
        maxP99DurationMs: 45 * 60_000,
        maxBacklog: 40,
        failureKindRules: [{ kind: 'evicted', maxShare: 0.05, minCount: 3 }],
      },
    }),
  ],
}

/** Nothing stored: every field is blank and keeps the deployment default, and no Reset all. */
export const Inheriting: Story = { decorators: [seeded()] }

/** Alerts muted for this account, with no other override. */
export const Muted: Story = { decorators: [seeded({ enabled: false })] }

/**
 * The account settings failed to load: a warning says so and Save is off, because a save would
 * replace the whole account config with this one key.
 */
export const NotLoaded: Story = {
  parameters: {
    api: [apiFailure(getAccountSettingsContract, { pathParams: { accountId: orgAccount.id } })],
  },
}
