import type { Meta, StoryObj } from '@storybook/vue3'
import EmptyState from './EmptyState.vue'

// The SPA's one "nothing here yet" render, for every list, panel section and picker that can be
// empty. It draws no border of its own, because it sits inside a panel that has one.
const meta = {
  title: 'Primitives/Components/EmptyState',
  component: EmptyState,
} satisfies Meta<typeof EmptyState>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { title: 'No runs yet' } }

export const WithDescription: Story = {
  args: {
    title: 'No runs yet',
    description: 'Start a task to see its pipeline here.',
  },
}

/** Compact: less padding and smaller type. */
export const Compact: Story = {
  args: { title: 'Nothing is waiting on you', compact: true, icon: 'i-lucide-check' },
}
