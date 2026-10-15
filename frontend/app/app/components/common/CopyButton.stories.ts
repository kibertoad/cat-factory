import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import CopyButton from './CopyButton.vue'

// An icon-only copy button. Its label is the tooltip and the accessible name, and is "Copy" when
// the caller gives none.
const meta = {
  title: 'Primitives/Components/CopyButton',
  component: CopyButton,
  args: { text: 'ws_43e7059d2b17400fbdce81e7' },
} satisfies Meta<typeof CopyButton>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

/** A caller's label, which names what is copied. Hovered, so the tooltip shows it. */
export const Labelled: Story = {
  args: { label: 'Copy the request id' },
  play: async ({ canvasElement }) => {
    await userEvent.hover(
      within(canvasElement).getByRole('button', { name: 'Copy the request id' }),
    )
  },
}
