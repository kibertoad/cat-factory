import type { Meta, StoryObj } from '@storybook/vue3'
import { seedUiMode, withSeed } from '~/stories/withStores'
import { getActivePinia } from 'pinia'
import UiModeSwitcher from './UiModeSwitcher.vue'

// The interface tier picker at the top of the sidebar: both tiers side by side, so the user can
// see that the other one exists, and a line on what the current tier gives. Basic is the default.
const meta = {
  title: 'Shell/Components/UiModeSwitcher',
  component: UiModeSwitcher,
  parameters: { width: 'narrow' },
} satisfies Meta<typeof UiModeSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** Basic, with its hint. */
export const Default: Story = {}

/** Advanced, with its hint. */
export const Advanced: Story = {
  decorators: [withSeed(() => seedUiMode('advanced'))],
}

/**
 * The collapsed sidebar, as wide as the rail (`w-14 px-2`): one button that flips the tier, with
 * the current tier's name under the icon. The name does not fit at that width and is cut.
 */
export const Collapsed: Story = {
  args: { collapsed: true },
  render: (args) => ({
    components: { UiModeSwitcher },
    setup: () => ({ args }),
    template: '<div class="w-14 px-2"><UiModeSwitcher v-bind="args" /></div>',
  }),
}

/**
 * The deployment pins the tier (`NUXT_PUBLIC_UI_MODE`), so the row only states it, with a lock.
 * The store reads the pin once, when it is created, and the app's plugins create it before any
 * seed runs. So the seed sets the pin, then drops the store, and the switcher creates a new one
 * that reads it.
 */
export const Pinned: Story = {
  decorators: [
    withSeed(() => {
      useRuntimeConfig().public.uiMode = 'advanced'
      useUiModeStore().$dispose()
      const pinia = getActivePinia()
      if (pinia) delete pinia.state.value.uiMode
    }),
  ],
}
