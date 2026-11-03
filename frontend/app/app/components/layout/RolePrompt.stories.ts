import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useUiRoleStore } from '~/stores/uiRole'
import RolePrompt from './RolePrompt.vue'

// The first-run question about the user's role. The role store holds whether it is open, so each
// story opens it in the seed. Picking a role records it and closes the prompt.
const meta = {
  title: 'Shell/Components/RolePrompt',
  component: RolePrompt,
} satisfies Meta<typeof RolePrompt>
export default meta

type Story = StoryObj<typeof meta>

/** Asked at launch: no role chosen, each role with what it gives, and Later. */
export const Default: Story = {
  decorators: [withSeed(() => useUiRoleStore().openPrompt())],
}

/**
 * Opened again after a choice, as the command palette does: the chosen role is highlighted and
 * the button says Close.
 */
export const Chosen: Story = {
  decorators: [
    withSeed(() => {
      const uiRole = useUiRoleStore()
      uiRole.setRole('product-manager')
      uiRole.openPrompt()
    }),
  ],
}
