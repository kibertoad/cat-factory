import type { Meta, StoryObj } from '@storybook/vue3'
import {
  listEnvironmentHandlersContract,
  listEnvironmentUserHandlersContract,
  type EnvironmentHandlerView,
} from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { apiPending, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import {
  kubernetesHandler,
  registeredManifestType,
  workspaceManifestType,
} from '~/stories/infra.stories.mocks'
import { environmentHandlerTestApi, environmentHandlersApi } from '~/stories/setupApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import InfraHandlersConfigurator from './InfraHandlersConfigurator.vue'

// How a board stands up each provision type a service can declare, one section per type:
// Kubernetes (an engine and the cluster connection), Docker Compose (nothing to connect),
// Cloudflare Workers previews, and the custom types with an HTTP handler per type. The
// configurator loads the board's handlers and custom types when it opens. When a Kubernetes
// handler is saved it tests that connection at once, with the stored token, so each story answers
// those reads. On a local deployment it also loads the person's own overrides for this machine.
// When the handler read fails the configurator shows nothing, so it has no Unavailable story; the
// Infrastructure window's HandlersFailed story shows what is left.
// Each section's own states are in its own stories. The verdicts are the backend's own words.

const pathPrefix = storyWorkspacePrefix

const reached = environmentHandlerTestApi({
  ok: true,
  message: 'Reached https://k8s.staging.acme.dev:6443.',
})

/** The person's own k3d cluster, which replaces the staging cluster on this machine. */
const k3dOverride: EnvironmentHandlerView = {
  provisionType: 'kubernetes',
  manifestId: null,
  engine: 'local-k3s',
  providerId: 'kubernetes',
  label: 'k3d cat-factory',
  baseUrl: 'https://127.0.0.1:41583',
  connectedAt: Date.UTC(2026, 9, 9),
  secretKeys: ['apiToken'],
  acceptsManifestId: null,
  backendKind: 'kubernetes',
  config: {
    engine: 'local-k3s',
    kubernetes: {
      label: 'k3d cat-factory',
      apiServerUrl: 'https://127.0.0.1:41583',
      insecureSkipTlsVerify: true,
      namespaceTemplate: 'cf-{{pullNumber}}',
      url: {
        source: 'ingressTemplate',
        hostTemplate: 'cf-{{pullNumber}}.localtest.me',
        scheme: 'http',
        port: 18080,
      },
    },
  },
}

const meta = {
  title: 'Settings/Components/InfraHandlersConfigurator',
  component: InfraHandlersConfigurator,
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: [
      environmentHandlersApi([kubernetesHandler], [registeredManifestType, workspaceManifestType]),
      reached,
    ],
  },
} satisfies Meta<typeof InfraHandlersConfigurator>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The staging cluster connected and tested at once, Docker Compose, Cloudflare not connected, and
 * two custom types with no handler yet: the editor starts from the starter manifest.
 */
export const Default: Story = {}

/** Nothing connected and no custom type: the Kubernetes form, empty, and the add form. */
export const Empty: Story = {
  parameters: { api: [environmentHandlersApi([], [])] },
}

/** The handlers still loading: placeholder sections. */
export const Loading: Story = {
  parameters: { api: [apiPending(listEnvironmentHandlersContract, { pathPrefix })] },
}

/**
 * The saved cluster's test fails at once: its token was refused. The card still says "Connection
 * established", above the verdict.
 */
export const TokenRefused: Story = {
  parameters: {
    api: [
      environmentHandlersApi([kubernetesHandler], []),
      environmentHandlerTestApi({
        ok: false,
        message:
          'The apiserver rejected the ServiceAccount token (401 Unauthorized) — an authentication ' +
          'failure (the token is expired or no longer recognised by the cluster), not an RBAC one. ' +
          'If this worked before, on a local k3s/k3d/kind cluster it is usually because the token ' +
          'aged out (a `kubectl create token` token is short-lived — default 1 hour) or the ' +
          'cluster was recreated/reinstalled, which rotates its token-signing keys and invalidates ' +
          'every earlier token (a plain restart does not). Mint a fresh token and paste it into ' +
          'the token field, then test again: `kubectl create token <serviceaccount> -n ' +
          '<namespace>` (add `--duration=720h`, or create a long-lived ' +
          'kubernetes.io/service-account-token Secret, for a token that does not expire in an hour).',
      }),
    ],
  },
}

/**
 * A local deployment: the Local k3s engine too, and the person's own k3d cluster as an active
 * override for this machine, opened.
 */
export const LocalMode: Story = {
  decorators: [
    withSeed(() => {
      useAuthStore().localMode = { enabled: true, patLogin: { configured: [], installable: [] } }
    }),
  ],
  parameters: {
    api: [
      environmentHandlersApi([kubernetesHandler], [registeredManifestType]),
      reached,
      apiResponse(listEnvironmentUserHandlersContract, {
        pathParams: { workspaceId: STORY_WORKSPACE_ID },
        body: { handlers: [k3dOverride] },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await screen.findByRole('button', { name: /Personal override/ }))
    await within(canvasElement).findByText(/Override the workspace handler for this provision type/)
  },
}
