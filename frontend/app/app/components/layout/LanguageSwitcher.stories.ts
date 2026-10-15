import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import LanguageSwitcher from './LanguageSwitcher.vue'

// The language picker at the foot of the sidebar. The list comes from the locales in
// `nuxt.config.ts`, each under its own name. Picking one in a story switches the language of
// that story's app only.
const meta = {
  title: 'Shell/Components/LanguageSwitcher',
  component: LanguageSwitcher,
  parameters: { width: 'narrow' },
  render: (args) => ({
    components: { LanguageSwitcher },
    setup: () => ({ args }),
    template: '<LanguageSwitcher v-bind="args" />',
  }),
} satisfies Meta<typeof LanguageSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** Room for the menu, which opens upward out of the frame otherwise. */
const withMenuRoom: Story['render'] = (args) => ({
  components: { LanguageSwitcher },
  setup: () => ({ args }),
  template: '<div class="pt-96"><LanguageSwitcher v-bind="args" /></div>',
})

/** The label and the current language. */
export const Default: Story = {}

/** The collapsed sidebar: the icon only, with the language in the tooltip. */
export const Collapsed: Story = {
  args: { collapsed: true },
  render: (args) => ({
    components: { LanguageSwitcher },
    setup: () => ({ args }),
    template: '<div class="w-14 px-2"><LanguageSwitcher v-bind="args" /></div>',
  }),
}

/** Every locale, with a check on the current one. */
export const Open: Story = {
  render: withMenuRoom,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Language' }))
  },
}
