import type { Meta, StoryObj } from '@storybook/vue3'
import EnvSetupStepper from './EnvSetupStepper.vue'

// The step header of the environment setup wizard. The steps come from the setup journey's own
// graph: from a service frame's nudge the wizard skips the service picker. Without a running
// journey the first step is the current one, so these stories show only that position; a later
// step needs the wizard itself.
const meta = {
  title: 'Setup/Components/EnvSetupStepper',
  component: EnvSetupStepper,
  args: { instanceId: null, input: { frameId: null } },
} satisfies Meta<typeof EnvSetupStepper>
export default meta

type Story = StoryObj<typeof meta>

/** Opened from settings: the service picker first. */
export const Default: Story = {}

/** Opened for one service: the picker is skipped, so the steps start at the review. */
export const ForService: Story = { args: { input: { frameId: 'svc_auth' } } }
