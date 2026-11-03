import type { Meta, StoryObj } from '@storybook/vue3'
import AccountConfigNotLoaded from './AccountConfigNotLoaded.vue'

// The notice a Team-tab settings panel shows in place of its editor when the account's settings
// did not load, so its save is disabled.
const meta = {
  title: 'Settings/Components/AccountConfigNotLoaded',
  component: AccountConfigNotLoaded,
  parameters: { width: 'prose' },
} satisfies Meta<typeof AccountConfigNotLoaded>
export default meta

type Story = StoryObj<typeof meta>

/** The one state it has. */
export const Default: Story = {}
