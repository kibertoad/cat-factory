import type { Meta, StoryObj } from '@storybook/vue3'
import type { PersonalSubscriptionStatus } from '@cat-factory/contracts'
import { listPersonalSubscriptionsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { signedInUser } from '~/stories/accounts.stories.mocks'
import { personalSubscription } from '~/stories/providers.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import PersonalSubscriptionSection from './PersonalSubscriptionSection.vue'

// The signed-in user's own subscriptions (Claude, the Z.ai coding plan, ChatGPT), which are
// licensed for one person and so are not pooled on the board: the connected ones with their
// expiry, a warning for any that is due or past renewal, and the form that connects one under a
// personal password. The section loads the user's subscriptions when it mounts, so each story
// answers that read. Without a signed-in user the form is off.
function subscriptionsAre(subscriptions: PersonalSubscriptionStatus[]) {
  return apiResponse(listPersonalSubscriptionsContract, { body: { subscriptions } })
}

const meta = {
  title: 'Settings/Components/PersonalSubscriptionSection',
  component: PersonalSubscriptionSection,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useAuthStore().user = signedInUser
    }),
  ],
  parameters: { width: 'prose', api: [subscriptionsAre([personalSubscription()])] },
} satisfies Meta<typeof PersonalSubscriptionSection>
export default meta

type Story = StoryObj<typeof meta>

/** Claude Max connected with its renewal date, and the form, which now replaces it. */
export const Default: Story = {}

/** Nothing connected: the form only. */
export const Empty: Story = { parameters: { api: [subscriptionsAre([])] } }

/** Claude Max renews in four days and the Z.ai plan has lapsed: a warning line for each. */
export const RenewalDue: Story = {
  parameters: {
    api: [
      subscriptionsAre([
        personalSubscription({
          expiresAt: Date.UTC(2026, 9, 16),
          expiresInDays: 4,
          renewSoon: true,
        }),
        personalSubscription({
          vendor: 'glm',
          label: 'Z.ai Coding Plan',
          expiresAt: Date.UTC(2026, 9, 1),
          expiresInDays: -11,
          expired: true,
        }),
      ]),
    ],
  },
}

/** No one is signed in: a notice, and every field is off. */
export const SignInRequired: Story = {
  decorators: [
    withSeed(() => {
      useAuthStore().user = null
    }),
  ],
  parameters: { api: [subscriptionsAre([])] },
}
