import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import LoadFailedState from './LoadFailedState.vue'

// The SPA's one "the read failed" render, the sibling of `EmptyState`: a list, panel or window whose
// load did not answer says so, instead of looking empty or switched off.
const meta = {
  title: 'Primitives/Components/LoadFailedState',
  component: LoadFailedState,
} satisfies Meta<typeof LoadFailedState>
export default meta

type Story = StoryObj<typeof meta>

/** The generic title, with a retry. */
export const Default: Story = { args: { onRetry: fn() } }

export const WithDescription: Story = {
  args: {
    title: 'Could not read the specification',
    description: 'The repository read failed, so it is not known if this service has a spec.',
    onRetry: fn(),
  },
}

/** No `retry` listener: the state with no button, for a read a retry would not fix. */
export const WithoutRetry: Story = {
  args: { title: 'The specification file is not valid' },
}

/** The retry in flight. */
export const Retrying: Story = { args: { onRetry: fn(), retrying: true } }

/** Compact: the inline size for an inspector section or a picker. */
export const Compact: Story = {
  args: { title: 'Could not list this folder', compact: true, onRetry: fn() },
}
