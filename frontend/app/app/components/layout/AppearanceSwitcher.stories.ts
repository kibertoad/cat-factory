import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { withSeed } from '~/stories/withStores'
import { useThemeStore } from '~/stores/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '~/utils/theme/builtins'
import AppearanceSwitcher from './AppearanceSwitcher.vue'

// The appearance picker at the foot of the sidebar: the colour mode and the theme in one menu,
// and the theme import. The mode shown is the colour mode module's preference, so the stories
// show whatever that module holds in this browser; the preview's own light and dark toggle sets
// the page class, not that preference. Picking a mode or a theme in a story restyles the preview.
const meta = {
  title: 'Shell/Components/AppearanceSwitcher',
  component: AppearanceSwitcher,
  parameters: { width: 'narrow' },
  render: (args) => ({
    components: { AppearanceSwitcher },
    setup: () => ({ args }),
    template: '<AppearanceSwitcher v-bind="args" />',
  }),
} satisfies Meta<typeof AppearanceSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** Room for the menu, which opens upward out of the frame otherwise. */
const withMenuRoom: Story['render'] = (args) => ({
  components: { AppearanceSwitcher },
  setup: () => ({ args }),
  template: '<div class="pt-80"><AppearanceSwitcher v-bind="args" /></div>',
})

const openMenu: Story['play'] = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Appearance' }))
}

/** The label, then the theme and the mode. */
export const Default: Story = {}

/** The collapsed sidebar: the mode icon only, with the summary in the tooltip. */
export const Collapsed: Story = {
  args: { collapsed: true },
  render: (args) => ({
    components: { AppearanceSwitcher },
    setup: () => ({ args }),
    template: '<div class="w-14 px-2"><AppearanceSwitcher v-bind="args" /></div>',
  }),
}

/** The three modes, the built-in themes and Import a theme. */
export const Open: Story = {
  render: withMenuRoom,
  play: openMenu,
}

/**
 * An imported theme is current, so the menu also offers to remove it. The seeded theme reuses the
 * default theme's document, so the preview does not change colour.
 */
export const CustomTheme: Story = {
  render: withMenuRoom,
  decorators: [
    withSeed(() => {
      const theme = useThemeStore()
      const base = BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0]!
      theme.custom = [{ id: 'custom-acme', name: 'Acme brand', doc: base.doc }]
      theme.select('custom-acme')
    }),
  ],
  play: openMenu,
}
