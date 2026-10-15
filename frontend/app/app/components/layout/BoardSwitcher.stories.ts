import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent, within } from 'storybook/test'
import { accountBoards as boards, accounts, orgAccount } from '~/stories/accounts.stories.mocks'
import { STORY_WORKSPACE_ID } from '~/stories/api'
import { seedViewer, withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useWorkspaceStore } from '~/stores/workspace'
import BoardSwitcher from './BoardSwitcher.vue'

// The account and board selectors at the top of the sidebar. The account row shows only when
// the user has accounts (auth on). Both menus open on click, so the open stories click in a play,
// and the wrapper leaves room below for the menu.
//
// The menus mark the open board, the active account and the account's provider with a
// `trailingIcon` check, which Nuxt UI's dropdown item does not have, so no check shows.
const meta = {
  title: 'Shell/Components/BoardSwitcher',
  component: BoardSwitcher,
  parameters: { width: 'narrow' },
  decorators: [withSeed(() => seedBoards())],
  render: (args) => ({
    components: { BoardSwitcher },
    setup: () => ({ args }),
    template: '<div class="pb-72"><BoardSwitcher v-bind="args" /></div>',
  }),
} satisfies Meta<typeof BoardSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** The two accounts, Acme active, and Core services open. */
function seedBoards() {
  const accountsStore = useAccountsStore()
  accountsStore.accounts = accounts
  accountsStore.activeAccountId = orgAccount.id
  const workspace = useWorkspaceStore()
  workspace.workspaces = boards
  workspace.workspaceId = STORY_WORKSPACE_ID
}

async function openBoardMenu(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByTestId('board-switcher'))
}

/** The account row above the board button, both closed. */
export const Default: Story = {}

/**
 * The Acme boards: Payments with a lock, Mobile app marked Viewer. Under them: new, rename and
 * delete.
 */
export const BoardMenuOpen: Story = {
  play: async ({ canvasElement }) => openBoardMenu(canvasElement),
}

/**
 * The accounts, then new organization, account settings and, for an account admin, the default
 * cloud provider, whose submenu opens on hover.
 */
export const AccountMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Acme' }))
    await userEvent.hover(await screen.findByText('Default cloud provider'))
    await screen.findByText('Docker (local)')
  },
}

/** The collapsed sidebar: no account row, and the board button shows only its icon. */
export const Collapsed: Story = {
  args: { collapsed: true },
  render: (args) => ({
    components: { BoardSwitcher },
    setup: () => ({ args }),
    template: '<div class="w-14 px-2"><BoardSwitcher v-bind="args" /></div>',
  }),
}

/** Auth off: no accounts, so no account row, and the menu lists every board. */
export const NoAccounts: Story = {
  decorators: [
    withSeed(() => {
      useAccountsStore().accounts = []
      useWorkspaceStore().workspaces = boards.map((b) => ({
        ...b,
        accountId: null,
        viewerRole: undefined,
      }))
    }),
  ],
  play: async ({ canvasElement }) => openBoardMenu(canvasElement),
}

/**
 * A viewer of the open board: it is marked Viewer, and there is no rename or delete, because both
 * need `settings.manage`.
 */
export const Viewer: Story = {
  decorators: [
    withSeed(() => {
      seedViewer()
      useWorkspaceStore().workspaces = boards.map((b) =>
        b.id === STORY_WORKSPACE_ID ? { ...b, viewerRole: 'viewer' } : b,
      )
    }),
  ],
  play: async ({ canvasElement }) => openBoardMenu(canvasElement),
}

/** New board: the name and the optional description. */
export const NewBoardPrompt: Story = {
  play: async ({ canvasElement }) => {
    await openBoardMenu(canvasElement)
    await userEvent.click(await screen.findByTestId('board-new'))
    await screen.findByPlaceholderText('What is this board for?')
  },
}
