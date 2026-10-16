import type { Meta, StoryObj } from '@storybook/vue3'
import type { EnvironmentHandlerView } from '@cat-factory/contracts'
import { testEnvironmentHandlerContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useInfraConfigStore } from '~/stores/infraConfig'
import CloudflareHandlerSection from './CloudflareHandlerSection.vue'

// How a board's Cloudflare Worker previews are reached: the account's workers.dev subdomain, the
// source-control token the preview workflow is triggered with, an optional pinned repository, and
// the two name templates the workflow agrees on. Connected, it shows one line and edit and
// disconnect; otherwise, the form. Test asks the backend to try the token. Each story seeds the
// board's handlers, so nothing loads; the account and repository are made up.
const cloudflareHandler: EnvironmentHandlerView = {
  provisionType: 'cloudflare',
  manifestId: null,
  engine: 'cloudflare',
  providerId: 'cloudflare',
  label: 'Cloudflare Workers preview',
  baseUrl: 'https://api.github.com',
  connectedAt: Date.UTC(2026, 9, 4),
  secretKeys: ['githubToken'],
  acceptsManifestId: null,
  backendKind: 'cloudflare',
  config: {
    engine: 'cloudflare',
    cloudflare: {
      label: 'Cloudflare Workers preview',
      workersSubdomain: 'acme-previews',
      repo: 'acme/web-app',
      workerNameTemplate: 'web-pr-{{pullNumber}}',
    },
  },
}

function seeded(handlers: EnvironmentHandlerView[]) {
  return withSeed(() => {
    seedWorkspace()
    const infra = useInfraConfigStore()
    infra.handlers = handlers
    infra.available = true
  })
}

const meta = {
  title: 'Settings/Components/CloudflareHandlerSection',
  component: CloudflareHandlerSection,
  decorators: [seeded([cloudflareHandler])],
  parameters: { width: 'prose' },
} satisfies Meta<typeof CloudflareHandlerSection>
export default meta

type Story = StoryObj<typeof meta>

/** Connected: the workers.dev subdomain, with edit and disconnect. */
export const Default: Story = {}

/** Not connected: the form, with the label prefilled and the rest empty. */
export const Empty: Story = { decorators: [seeded([])] }

/** Editing the connected handler: the stored values, and a token field that keeps the stored one. */
export const Editing: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  },
}

/** The advanced section open: the two name templates and the API base URL. */
export const AdvancedOpen: Story = {
  decorators: [seeded([])],
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }))
  },
}

/** Test with no token stored: the backend's refusal, as it words it. */
export const TestFailed: Story = {
  decorators: [seeded([])],
  parameters: {
    api: [
      apiResponse(testEnvironmentHandlerContract, {
        pathPrefix: storyWorkspacePrefix,
        body: {
          ok: false,
          message: "The Cloudflare preview connection has no 'githubToken' secret configured.",
        },
      }),
    ],
  },
  play: async () => {
    await userEvent.type(await screen.findByPlaceholderText('my-account'), 'acme-previews')
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  },
}
