import type { Meta, StoryObj } from '@storybook/vue3'
import DecisionBadge from './DecisionBadge.vue'

// The pulsing pill on a card that waits on a human. A card carries one for decisions and one for
// approvals; the count shows only when there is more than one.
const meta = {
  title: 'Board/Components/DecisionBadge',
  component: DecisionBadge,
} satisfies Meta<typeof DecisionBadge>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

/** Compact, as on a zoomed-out board: the glyph only. It has no accessible name. */
export const Compact: Story = { args: { compact: true } }

/** Three decisions on the same card. */
export const WithCount: Story = { args: { count: 3 } }

/** The approval variant, with the copy and glyph `BlockNode` passes. */
export const Approval: Story = {
  args: { label: 'Approval needed', icon: 'i-lucide-shield-check' },
}
