import type { Meta, StoryObj } from '@storybook/vue3'
import AsyncViewError from './AsyncViewError.vue'

// What a code-split surface shows when its chunk fails to load (`utils/asyncView.ts`). It is a
// full-screen scrim with one card, and its only action is a reload.
const meta = {
  title: 'Primitives/Components/AsyncViewError',
  component: AsyncViewError,
} satisfies Meta<typeof AsyncViewError>
export default meta

export const Default: StoryObj<typeof meta> = {}
