import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, screen, userEvent, within } from 'storybook/test'
import { withSeed } from '~/stories/withStores'
import { useUiRoleStore } from '~/stores/uiRole'
import UiRoleSwitcher from './UiRoleSwitcher.vue'

// The role picker at the top of the sidebar. With no role chosen it shows the default role,
// engineer, which sees the whole product. The menu opens downward.
const meta = {
  title: 'Shell/Components/UiRoleSwitcher',
  component: UiRoleSwitcher,
  parameters: { width: 'narrow' },
  render: (args) => ({
    components: { UiRoleSwitcher },
    setup: () => ({ args }),
    template: '<UiRoleSwitcher v-bind="args" />',
  }),
} satisfies Meta<typeof UiRoleSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** Room for the menu, which opens downward out of the frame otherwise. */
const withMenuRoom: Story['render'] = (args) => ({
  components: { UiRoleSwitcher },
  setup: () => ({ args }),
  template: '<div class="pb-40"><UiRoleSwitcher v-bind="args" /></div>',
})

/** No role chosen yet, so the default: engineer. */
export const Default: Story = {}

/**
 * The collapsed sidebar, as wide as the rail (`w-14 px-2`): the role's icon over its name. The
 * name does not fit at that width and is cut to its first letters.
 */
export const Collapsed: Story = {
  args: { collapsed: true },
  render: (args) => ({
    components: { UiRoleSwitcher },
    setup: () => ({ args }),
    template: '<div class="w-14 px-2"><UiRoleSwitcher v-bind="args" /></div>',
  }),
}

/** The three roles, the current one (engineer) marked with a check. */
export const Open: Story = {
  render: withMenuRoom,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Your role' }))
    await screen.findByText('Product manager')
    const current = screen.getAllByRole('menuitem').filter((r) => r.ariaCurrent)
    await expect(current).toHaveLength(1)
    await expect(current[0]).toHaveTextContent('Engineer')
    await expect(current[0]!.querySelector('[data-slot="itemTrailing"]')?.childElementCount).toBe(1)
  },
}

/** A designer, with the designer icon. */
export const Designer: Story = {
  decorators: [withSeed(() => useUiRoleStore().setRole('designer'))],
}
