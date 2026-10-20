import type { Meta, StoryObj } from '@storybook/vue3'
import { listVendorCredentialsContract, type VendorCredential } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { signedInUser } from '~/stories/accounts.stories.mocks'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { apiKey, personalSubscription, vendorCredential } from '~/stories/providers.stories.mocks'
import { providersApi } from '~/stories/providersApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import { useUiStore } from '~/stores/ui'
import VendorCredentialsModal from './VendorCredentialsModal.vue'

// The window for the model credentials of a board, on four tabs: the board's pool of
// coding-plan subscriptions (Kimi and DeepSeek, the plans licensed for a team), the vendor API
// keys, the gateway keys, and the person's own subscriptions. It loads the pool when it opens,
// and each other tab loads its own list when it shows, so each story answers those reads. The
// tabs other than the pool are the `ApiKeysSection` and `PersonalSubscriptionSection` stories
// inside the window; their own states are there.

/** The board's pool: the Kimi plan, pinned, and a DeepSeek plan switched off. */
const pool: VendorCredential[] = [
  vendorCredential({ id: 'vc_kimi_team', vendor: 'kimi', label: 'Team Kimi' }),
  vendorCredential({
    id: 'vc_deepseek_ci',
    vendor: 'deepseek',
    label: 'CI DeepSeek',
    lastUsedAt: Date.UTC(2026, 8, 28, 9, 30),
    inputTokens: 96_400,
    outputTokens: 14_200,
    requestCount: 41,
    enabled: false,
    isDefault: false,
  }),
]

function poolIs(credentials: VendorCredential[]): HttpHandler {
  return apiResponse(listVendorCredentialsContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { credentials },
  })
}

/** The window opened on `tab`, as the hub and the "My subscriptions" entry open it. */
function opened(tab = 'pool') {
  return withSeed(() => {
    seedWorkspace()
    useAuthStore().user = signedInUser
    useUiStore().openVendorCredentials(tab)
  })
}

const reads = [
  poolIs(pool),
  ...providersApi({
    workspaceKeys: [
      apiKey({ id: 'key_anthropic_team', provider: 'anthropic', label: 'Team Anthropic' }),
      apiKey(),
    ],
    subscriptions: [personalSubscription()],
  }),
]

const meta = {
  title: 'Settings/Components/VendorCredentialsModal',
  component: VendorCredentialsModal,
  decorators: [opened()],
  parameters: { api: reads },
} satisfies Meta<typeof VendorCredentialsModal>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The pool tab: the pointer to the person's own subscriptions, Kimi's steps, the form, and the
 * two plans in the pool.
 */
export const Default: Story = {}

/** Nothing in the pool yet. */
export const Empty: Story = {
  parameters: { api: [poolIs([]), ...providersApi()] },
}

/** The vendor keys tab: the board's Anthropic key. */
export const DirectKeys: Story = {
  decorators: [opened('direct')],
}

/** The gateway keys tab: the board's OpenRouter key. */
export const ProxyKeys: Story = {
  decorators: [opened('proxy')],
}

/** Opened from "My subscriptions": the person's own Claude Max. */
export const Personal: Story = {
  decorators: [opened('personal')],
}
