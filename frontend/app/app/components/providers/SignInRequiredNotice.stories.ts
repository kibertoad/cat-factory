import type { Meta, StoryObj } from '@storybook/vue3'
import SignInRequiredNotice from './SignInRequiredNotice.vue'

// The banner on a per-user credential form when the deployment runs without sign-in, so there is
// no user to store the credential against. The caller passes the copy for its form.
const meta = {
  title: 'Settings/Components/SignInRequiredNotice',
  component: SignInRequiredNotice,
  parameters: { width: 'panel' },
} satisfies Meta<typeof SignInRequiredNotice>
export default meta

type Story = StoryObj<typeof meta>

/** The personal-subscriptions form. */
export const Default: Story = {
  args: {
    message:
      "Personal subscriptions are saved to your account, but this deployment runs without sign-in, so they can't be stored here. Use the workspace pool or a provider API key instead.",
  },
}
