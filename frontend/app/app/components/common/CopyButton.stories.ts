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
  // The hover opens the tooltip in the Storybook UI. The test runner's hover does not open it,
  // so the play waits for what the label sets in both: the button's accessible name.
  play: async ({ canvasElement }) => {
    const button = await within(canvasElement).findByRole('button', {
      name: 'Copy the request id',
    })
    await userEvent.hover(button)
  },
}
