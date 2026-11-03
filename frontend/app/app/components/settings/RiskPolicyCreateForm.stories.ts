import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, fn, userEvent, within } from 'storybook/test'
import RiskPolicyCreateForm from './RiskPolicyCreateForm.vue'

// The create row for a new merge policy, shared by the board and account tiers: a name and the
// numbers. The fields start from the blank draft. Rules by class and by role are edited on the
// saved policy, not here.
const meta = {
  title: 'Settings/Components/RiskPolicyCreateForm',
  component: RiskPolicyCreateForm,
  args: { busy: false, onCreate: fn() },
} satisfies Meta<typeof RiskPolicyCreateForm>
export default meta

type Story = StoryObj<typeof meta>

/** The blank row: Add stays disabled until a name is typed, and enables after it. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const add = canvas.getByTestId('risk-policy-create-submit')
    await expect(add).toBeDisabled()
    await userEvent.type(canvas.getByTestId('risk-policy-create-name'), 'Release train')
    await expect(add).toBeEnabled()
  },
}

/** A create request in flight: with a name typed, Add spins and stays disabled. */
export const Busy: Story = {
  args: { busy: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByTestId('risk-policy-create-name'), 'Release train')
    await expect(canvas.getByTestId('risk-policy-create-submit')).toBeDisabled()
  },
}
