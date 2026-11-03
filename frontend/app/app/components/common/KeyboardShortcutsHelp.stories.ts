import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp.vue'

// The cheatsheet that "?" opens. It takes no props: the UI store holds whether it is open, so the
// story opens it in the seed. The modifier key comes from the browser that renders the story:
// ⌘ on an Apple machine, Ctrl elsewhere.
const meta = {
  title: 'Shell/Components/KeyboardShortcutsHelp',
  component: KeyboardShortcutsHelp,
  decorators: [withSeed(() => useUiStore().openShortcutsHelp())],
} satisfies Meta<typeof KeyboardShortcutsHelp>
export default meta

type Story = StoryObj<typeof meta>

/** The four global shortcuts. */
export const Default: Story = {}
