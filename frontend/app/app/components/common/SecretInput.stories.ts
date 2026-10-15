import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import SecretInput from './SecretInput.vue'

// A masked input with a reveal toggle. With `secret: false` it is a plain text input, so a form
// field whose secrecy depends on data can bind this one component either way.
const meta = {
  title: 'Primitives/Components/SecretInput',
  component: SecretInput,
  parameters: { width: 'panel' },
} satisfies Meta<typeof SecretInput>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { modelValue: 'sk-live-0000000000000000' } }

/**
 * Revealed, so the user can check a pasted key. Here the toggle still draws an open eye: the
 * icon rule injected for `eye-off` carries the `eye` SVG. Not yet compared with the app.
 */
export const Revealed: Story = {
  args: { modelValue: 'sk-live-0000000000000000' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Reveal' }))
  },
}

export const PlainText: Story = { args: { secret: false, modelValue: 'acme-staging' } }
