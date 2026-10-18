import type { Meta, StoryObj } from '@storybook/vue3'
import Spinner from './Spinner.vue'

// The bare spinning icon, for where no Nuxt UI `:loading` prop applies. Its default glyph comes
// from `useAppConfig()`, so this story also proves the Nuxt app context is live in Storybook: if
// it throws NUXT_E1001, the preset's app-context write (nuxt-modules/storybook#1139) has regressed,
// in `@storybook-vue/nuxt` or in Nuxt.
const meta = {
  title: 'Primitives/Components/Spinner',
  component: Spinner,
} satisfies Meta<typeof Spinner>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

/** A status icon that has settled: the same element, not spinning. */
export const Still: Story = { args: { spinning: false } }
