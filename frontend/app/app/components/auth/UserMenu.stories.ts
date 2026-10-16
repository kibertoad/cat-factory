import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent, within } from 'storybook/test'
import { signedInUser } from '~/stories/accounts.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import UserMenu from './UserMenu.vue'

// The signed-in user at the foot of the sidebar, with a menu for personal setup and sign out. It
// renders nothing without a user, so every story seeds one into the auth store. The menu opens
// upward, so the open story leaves room above the button.
const meta = {
  title: 'Shell/Components/UserMenu',
  component: UserMenu,
  parameters: { width: 'narrow' },
  decorators: [
    withSeed(() => {
      useAuthStore().user = signedInUser
    }),
  ],
  render: (args) => ({
    components: { UserMenu },
    setup: () => ({ args }),
    template: '<UserMenu v-bind="args" />',
  }),
} satisfies Meta<typeof UserMenu>
export default meta

type Story = StoryObj<typeof meta>

/** Room for the menu, which opens upward out of the frame otherwise. */
const withMenuRoom: Story['render'] = (args) => ({
  components: { UserMenu },
  setup: () => ({ args }),
  template: '<div class="pt-28"><UserMenu v-bind="args" /></div>',
})

/** Name and login. With no avatar URL the avatar falls back to an icon. */
export const Default: Story = {}

/** The collapsed sidebar: the avatar only, with the name as the tooltip. */
export const Collapsed: Story = {
  args: { collapsed: true },
  render: (args) => ({
    components: { UserMenu },
    setup: () => ({ args }),
    template: '<div class="w-14 px-2"><UserMenu v-bind="args" /></div>',
  }),
}

/** The menu: My setup, then Sign out in its own group. */
export const Open: Story = {
  render: withMenuRoom,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('user-menu'))
    await screen.findByText('Sign out')
  },
}
