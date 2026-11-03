import type { Meta, StoryObj } from '@storybook/vue3'
import { accountBoards, accounts, orgAccount, signedInUser } from '~/stories/accounts.stories.mocks'
import { shellProbeApi } from '~/stories/shellApi'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, seedUiMode, withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useAuthStore } from '~/stores/auth'
import { useUiModeStore } from '~/stores/uiMode'
import { useUiRoleStore } from '~/stores/uiRole'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceStore } from '~/stores/workspace'
import SideBar from './SideBar.vue'

// The app's navbar: the board switcher, the role and tier switchers, the two work views, the
// command bar launcher, the navigation sections and, at the foot, appearance, language and the
// user. Which destinations show is decided by the role, then the tier, then each destination's own
// permission or connection, so every story answers the integration probes the navbar starts on a
// board open. At `lg` (1024px) and wider it is a static column that can collapse to a rail of
// icons; narrower, it is a drawer over the board. Each story sets its viewport, and the layout is
// fullscreen so the column takes the frame's height. The security dashboard's raw key and the two
// external tools come from the example module this deployment registers.
const meta = {
  title: 'Shell/Components/SideBar',
  component: SideBar,
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot())
      const accountsStore = useAccountsStore()
      accountsStore.accounts = accounts
      accountsStore.activeAccountId = orgAccount.id
      useWorkspaceStore().workspaces = accountBoards
      useAuthStore().user = signedInUser
      // The tier picks the rail's default; the expanded stories pin it open.
      useUiModeStore().setNavCollapsed(false)
    }),
  ],
  parameters: { layout: 'fullscreen', api: shellProbeApi() },
  globals: { viewport: { value: 'desktop' } },
  render: () => ({
    components: { SideBar },
    template: '<div class="flex h-screen"><SideBar /></div>',
  }),
} satisfies Meta<typeof SideBar>
export default meta

type Story = StoryObj<typeof meta>

/** Basic tier, expanded: the destinations of the everyday delivery loop. */
export const Default: Story = {}

/** Advanced tier: the advanced destinations join each section. */
export const Advanced: Story = {
  decorators: [
    withSeed(() => {
      seedUiMode('advanced')
      useUiModeStore().setNavCollapsed(false)
    }),
  ],
}

/** The rail: icons only, with each name in the tooltip. Basic tier starts here. */
export const Railed: Story = {
  decorators: [withSeed(() => useUiModeStore().setNavCollapsed(true))],
}

/**
 * The designer role: no tier switcher, and only the destinations that bring work in, with the
 * role switcher kept as the way back.
 */
export const NarrowedRole: Story = {
  decorators: [withSeed(() => useUiRoleStore().setRole('designer'))],
}

/** A phone: the drawer open at its full width, with the backdrop that dims the board beside it. */
export const MobileDrawer: Story = {
  globals: { viewport: { value: 'mobile2' } },
  decorators: [withSeed(() => useUiStore().openMobileNav())],
}
