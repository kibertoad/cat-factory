import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, screen } from 'storybook/test'
import type { OpenRouterModelMeta, OpenRouterRefreshResult } from '@cat-factory/contracts'
import {
  getOpenRouterCatalogContract,
  refreshOpenRouterCatalogContract,
} from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { apiKey } from '~/stories/providers.stories.mocks'
import { providersApi } from '~/stories/providersApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import OpenRouterCatalogPanel from './OpenRouterCatalogPanel.vue'

// OpenRouter, one gateway to many models: connect a key here, then tick the models the board
// may use, each with its context window and price per million tokens, and a line when OpenRouter
// has dated its withdrawal. Enable recommended ticks the curated ones it serves. The window loads
// the board's keys and its enabled models when it opens, and with a key it reads OpenRouter's live
// list at once, so each story answers those reads. The models and prices are made up.
function model(id: string, name: string, overrides: Partial<OpenRouterModelMeta> = {}) {
  return {
    id,
    name,
    contextLength: 200_000,
    inputPerMillion: 3,
    outputPerMillion: 15,
    ...overrides,
  }
}

const enabled: OpenRouterModelMeta[] = [
  model('anthropic/claude-opus-5.5', 'Claude Opus 5.5', {
    inputPerMillion: 15,
    outputPerMillion: 75,
  }),
  model('moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code', {
    contextLength: 256_000,
    inputPerMillion: 0.6,
    outputPerMillion: 2.5,
  }),
]

const live: OpenRouterModelMeta[] = [
  ...enabled,
  model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
  model('openai/gpt-6.1-sol', 'GPT-6.1 Sol', {
    contextLength: 400_000,
    inputPerMillion: 5,
    outputPerMillion: 20,
  }),
  model('mistralai/codestral-2601', 'Codestral 2601', {
    contextLength: 128_000,
    inputPerMillion: 0.3,
    outputPerMillion: 0.9,
    expirationDate: '2026-12-31',
  }),
]

function answers(options: { key: boolean | 'disabled'; refresh?: OpenRouterRefreshResult }) {
  const keys = options.key ? [apiKey({ enabled: options.key !== 'disabled' })] : []
  return [
    ...providersApi({ workspaceKeys: keys }),
    apiResponse(getOpenRouterCatalogContract, {
      pathParams: { workspaceId: STORY_WORKSPACE_ID },
      body: {
        models: options.key === true ? enabled : [],
        createdAt: Date.UTC(2026, 8, 2),
        updatedAt: Date.UTC(2026, 9, 1),
      },
    }),
    apiResponse(refreshOpenRouterCatalogContract, {
      pathParams: { workspaceId: STORY_WORKSPACE_ID },
      body: options.refresh ?? { reachable: true, models: live },
    }),
  ]
}

const meta = {
  title: 'Settings/Components/OpenRouterCatalogPanel',
  component: OpenRouterCatalogPanel,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openOpenRouter()
    }),
  ],
  parameters: { api: answers({ key: true }) },
} satisfies Meta<typeof OpenRouterCatalogPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A key connected: OpenRouter's live list of five, the two enabled ones ticked, and one model with
 * a withdrawal date.
 */
export const Default: Story = {}

/** No key yet: the steps to get one, and the form that connects it. */
export const Empty: Story = { parameters: { api: answers({ key: false }) } }

/** The only key is turned off: no form to paste a second one, and a way to the key list instead. */
export const KeyDisabled: Story = {
  parameters: { api: answers({ key: 'disabled' }) },
  play: async () => {
    await screen.findByText(
      'Your OpenRouter key is turned off. Turn it back on in Vendors & keys to browse models.',
    )
    await expect(screen.queryByText('Connect & browse')).toBeNull()
  },
}

/** OpenRouter refuses the key: the enabled models stay listed, under the backend's message. */
export const RefreshError: Story = {
  parameters: {
    api: answers({
      key: true,
      refresh: { reachable: false, models: [], error: 'OpenRouter returned HTTP 401' },
    }),
  },
}
