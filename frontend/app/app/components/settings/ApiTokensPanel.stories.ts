import type { Meta, StoryObj } from '@storybook/vue3'
import type { PublicApiKey } from '@cat-factory/contracts'
import { createPublicApiKeyContract } from '@cat-factory/contracts'
import { userEvent, screen } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { accountBoards, accounts, orgAccount, signedInUser } from '~/stories/accounts.stories.mocks'
import { seedUiMode, seedWorkspace, withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useAuthStore } from '~/stores/auth'
import { usePublicApiKeysStore } from '~/stores/publicApiKeys'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceStore } from '~/stores/workspace'
import ApiTokensPanel from './ApiTokensPanel.vue'

// The tokens external systems present to the public API for this board: each with its permission,
// its reach, whose subscription it runs on and who made it, with Revoke; and the form that mints
// one. A new token's secret shows once, to copy. An account admin in advanced mode can widen a
// token past this board. The stories seed the token list, so the window does not load it; the
// tokens, ids and secret are made up.
function key(overrides: Partial<PublicApiKey> & Pick<PublicApiKey, 'id' | 'label'>): PublicApiKey {
  return {
    accountId: orgAccount.id,
    workspaceId: STORY_WORKSPACE_ID,
    workspaceIds: [STORY_WORKSPACE_ID],
    scope: 'write',
    createdByUserId: signedInUser.id,
    createdByKeyId: null,
    externalIdentity: null,
    actsAsUserId: null,
    createdAt: Date.UTC(2026, 8, 18),
    lastUsedAt: Date.UTC(2026, 9, 12, 7, 45),
    revokedAt: null,
    ...overrides,
  }
}

const ciKey = key({ id: 'pak_ci', label: 'GitHub Actions' })
const dashboardKey = key({
  id: 'pak_dash',
  label: 'Status dashboard',
  scope: 'read',
  createdByUserId: 'usr_priya',
  lastUsedAt: null,
})

function seeded(options: {
  keys: PublicApiKey[]
  signedIn?: boolean
  roles?: typeof orgAccount.roles
  advanced?: boolean
}) {
  return withSeed(() => {
    seedWorkspace()
    useWorkspaceStore().workspaces = accountBoards
    const accountsStore = useAccountsStore()
    accountsStore.accounts = accounts.map((a) =>
      a.id === orgAccount.id ? { ...a, roles: options.roles ?? ['developer'] } : a,
    )
    accountsStore.activeAccountId = orgAccount.id
    useAuthStore().user = options.signedIn === false ? null : signedInUser
    seedUiMode(options.advanced ? 'advanced' : 'basic')
    const store = usePublicApiKeysStore()
    store.keys = options.keys
    store.available = true
    useUiStore().openApiTokens()
  })
}

const meta = {
  title: 'Settings/Components/ApiTokensPanel',
  component: ApiTokensPanel,
  decorators: [seeded({ keys: [ciKey, dashboardKey] })],
} satisfies Meta<typeof ApiTokensPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Two tokens: yours, used this morning, and Priya's, never used, shown by her user id. */
export const Default: Story = {}

/** No tokens yet: the form only. */
export const Empty: Story = { decorators: [seeded({ keys: [] })] }

/**
 * The badges a token can carry: a reach across every board, one across three, a binding to a
 * colleague's subscription, and a token another token minted.
 */
export const KeyBadges: Story = {
  decorators: [
    seeded({
      keys: [
        key({ id: 'pak_all', label: 'Org-wide reporting', scope: 'read', workspaceIds: null }),
        key({
          id: 'pak_three',
          label: 'Release bot',
          scope: 'decide',
          workspaceIds: [STORY_WORKSPACE_ID, 'ws_payments', 'ws_mobile'],
        }),
        key({
          id: 'pak_bound',
          label: 'Priya’s CLI',
          createdByUserId: 'usr_priya',
          actsAsUserId: 'usr_priya',
        }),
        key({
          id: 'pak_minted',
          label: 'Provisioned by Terraform',
          scope: 'admin',
          createdByUserId: null,
          createdByKeyId: 'pak_terraform',
        }),
      ],
    }),
  ],
}

/** An account admin in advanced mode: the Workspaces field that widens a new token's reach. */
export const AdminReach: Story = {
  decorators: [seeded({ keys: [ciKey], roles: ['admin'], advanced: true })],
}

/** No one signed in: no choice of whose subscription a token runs on. */
export const NoSignedInUser: Story = {
  decorators: [seeded({ keys: [ciKey], signedIn: false })],
}

/** A token just minted: its secret, shown once, to copy. */
export const SecretRevealed: Story = {
  decorators: [seeded({ keys: [] })],
  parameters: {
    api: [
      apiResponse(createPublicApiKeyContract, {
        pathPrefix: storyWorkspacePrefix,
        body: {
          key: key({ id: 'pak_new', label: 'Nightly import', lastUsedAt: null }),
          secret: 'cf_live_9fK2mQx7Lr4Tz8Wp1Vb6Nc3Hd5Js0Ya',
        },
      }),
    ],
  },
  play: async () => {
    await userEvent.type(await screen.findByTestId('api-token-label'), 'Nightly import')
    await userEvent.click(screen.getByTestId('api-token-create'))
    await screen.findByTestId('api-token-secret')
  },
}
