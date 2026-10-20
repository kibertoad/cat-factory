import type { Meta, StoryObj } from '@storybook/vue3'
import ComposeEnvironmentSetupSection from './ComposeEnvironmentSetupSection.vue'

// The Docker Compose setup section of the Infrastructure window's test environments tab: how the
// guided setup works, when a service needs it and when it does not, and the button that closes
// the window and opens the setup wizard. It has no state of its own.
const meta = {
  title: 'Settings/Components/ComposeEnvironmentSetupSection',
  component: ComposeEnvironmentSetupSection,
  parameters: { width: 'prose' },
} satisfies Meta<typeof ComposeEnvironmentSetupSection>
export default meta

type Story = StoryObj<typeof meta>

/** The four steps, the two lists side by side and the start button. */
export const Default: Story = {}
