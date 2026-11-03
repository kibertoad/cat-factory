import type { ButtonProps } from '@nuxt/ui'
import type { Meta, StoryObj } from '@storybook/vue3'
import IconButton from './IconButton.vue'

// `label` is required and is both the accessible name and the tooltip. A bare icon with no
// label is the thing this primitive exists to prevent.
//
// The glyph arrives as the `icon` ATTRIBUTE, which falls through to the inner UButton. There is
// no default slot: passing children renders nothing at all.
type IconButtonArgs = InstanceType<typeof IconButton>['$props'] &
  Pick<ButtonProps, 'icon' | 'disabled'>

const meta = {
  title: 'Primitives/Components/IconButton',
  component: IconButton,
  render: (args) => ({
    components: { IconButton },
    setup: () => ({ args }),
    template: '<IconButton v-bind="args" />',
  }),
} satisfies Meta<IconButtonArgs>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { label: 'Retry this run', icon: 'i-lucide-refresh-cw' } }

/** Disabled. The tooltip still opens, because its trigger is a span around the button. */
export const Disabled: Story = {
  args: { label: 'Retry this run', icon: 'i-lucide-refresh-cw', disabled: true },
}
