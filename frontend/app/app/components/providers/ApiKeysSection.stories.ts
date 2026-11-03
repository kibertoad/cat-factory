import type { Meta, StoryObj } from '@storybook/vue3'
import { orgAccount, signedInUser } from '~/stories/accounts.stories.mocks'
import { accountApiKeys, apiKey } from '~/stories/providers.stories.mocks'
import { accountApiKeysApi, providersApi } from '~/stories/providersApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import { useWorkspaceStore } from '~/stores/workspace'
import ApiKeysSection from './ApiKeysSection.vue'

// The API keys of one kind of provider: the vendors reached directly, or the gateways that front
// many vendors behind one key. On a board it shows the board's keys or the person's own, and
// opens on the board's for whoever may manage the board's secrets. With an account it shows the
// account's keys. Each has the steps to get a key from the provider, the form that adds one, and
// the keys already added, with their use, a default pin and an on switch. The section loads the
// keys of its scope, so each story answers that read.

/** The board's keys: a pinned Anthropic key, an OpenAI key switched off, and the OpenRouter key. */
const boardKeys = [
  apiKey({
    id: 'key_anthropic_team',
    provider: 'anthropic',
    label: 'Team Anthropic',
    inputTokens: 6_812_000,
    outputTokens: 1_204_900,
    requestCount: 1_932,
  }),
  apiKey({
    id: 'key_openai_ci',
    provider: 'openai',
    label: 'CI OpenAI',
    lastUsedAt: Date.UTC(2026, 8, 30, 11, 0),
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    enabled: false,
    isDefault: false,
  }),
  apiKey(),
]

/** Maya's own Anthropic key, which follows her to any board. */
const myKeys = [
  apiKey({
    id: 'key_anthropic_maya',
    scope: 'user',
    scopeId: signedInUser.id,
    provider: 'anthropic',
    label: 'Maya personal',
    inputTokens: 412_000,
    outputTokens: 88_100,
    requestCount: 96,
  }),
]

/** A board member: no `secrets.manage`, so the section opens on the person's own keys. */
function member(signedIn: boolean) {
  return withSeed(() => {
    seedWorkspace()
    useWorkspaceStore().access = {
      role: 'member',
      permissions: ['workspace.read', 'board.write', 'runs.execute'],
    }
    useAuthStore().user = signedIn ? signedInUser : null
  })
}

const meta = {
  title: 'Settings/Components/ApiKeysSection',
  component: ApiKeysSection,
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: providersApi({ workspaceKeys: boardKeys, userKeys: myKeys }),
  },
} satisfies Meta<typeof ApiKeysSection>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The board's vendor keys, for an admin: the Anthropic key pinned as the default, and the OpenAI
 * key switched off. The OpenRouter key is in the gateway section. The form starts on OpenAI,
 * with the line that says its key caches prompts.
 */
export const Default: Story = {}

/** No key added on this board yet. */
export const Empty: Story = {
  parameters: { api: providersApi() },
}

/** The gateway section: OpenRouter's steps and the board's OpenRouter key. */
export const Proxy: Story = {
  args: { category: 'proxy' },
}

/** A board member, who may not manage the board's keys: the section opens on their own key. */
export const MyKeys: Story = {
  decorators: [member(true)],
}

/**
 * The same member on a deployment with no sign-in: their own keys need a user, so the notice
 * says so, the form is off, and there are no keys of their own.
 */
export const SignInRequired: Story = {
  decorators: [member(false)],
  parameters: { api: providersApi({ workspaceKeys: boardKeys }) },
}

/** In the account's settings: the account's Anthropic key, and no scope field. */
export const Account: Story = {
  args: { accountId: orgAccount.id },
  parameters: { api: [accountApiKeysApi(accountApiKeys)] },
}
