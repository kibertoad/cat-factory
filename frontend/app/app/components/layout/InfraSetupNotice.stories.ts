import type { DropdownMenuItem } from '@nuxt/ui'
import type { Meta, StoryObj } from '@storybook/vue3'
import InfraSetupNotice from './InfraSetupNotice.vue'

// The one line a person sees when no agent runner is set up (or it is down) and they cannot fix
// it from where they are: what does not work, and who fixes it. An outage is red; a setup gap is
// amber. The close button opens the dismiss menu the board's setup banner passes; the render
// builds the same items, with the setup gap's two choices.
const meta = {
  title: 'Setup/Components/InfraSetupNotice',
  component: InfraSetupNotice,
  args: {
    notice: { area: 'agentExecutor', kind: 'setup', remedy: 'workspace_admin' },
    dismissMenu: [],
  },
  render: (args) => ({
    components: { InfraSetupNotice },
    setup() {
      const { t } = useI18n()
      const dismissMenu: DropdownMenuItem[][] = [
        [
          { label: t('layout.infraSetupBanner.dismiss.session'), icon: 'i-lucide-clock' },
          { label: t('layout.infraSetupBanner.dismiss.permanent'), icon: 'i-lucide-bell-off' },
        ],
      ]
      return { args, dismissMenu }
    },
    template: '<InfraSetupNotice v-bind="args" :dismiss-menu="dismissMenu" />',
  }),
} satisfies Meta<typeof InfraSetupNotice>
export default meta

type Story = StoryObj<typeof meta>

/** No runner set up, and a workspace admin can fix it. */
export const Default: Story = {}

/** The runner is set up but does not answer: the red outage line. */
export const Outage: Story = {
  args: { notice: { area: 'agentExecutor', kind: 'outage', remedy: 'workspace_admin' } },
}

/** The fix belongs to an account admin. */
export const AccountAdmin: Story = {
  args: { notice: { area: 'agentExecutor', kind: 'setup', remedy: 'account_admin' } },
}

/** The fix belongs to whoever operates the deployment. */
export const Operator: Story = {
  args: { notice: { area: 'agentExecutor', kind: 'setup', remedy: 'operator' } },
}

/** The person could fix it, but only from the full interface, not their narrowed role. */
export const FullSurface: Story = {
  args: { notice: { area: 'agentExecutor', kind: 'setup', remedy: 'full_surface' } },
}
