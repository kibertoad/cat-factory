import type { Meta, StoryObj } from '@storybook/vue3'
import {
  describeRunnerPoolProviderContract,
  getRunnerPoolConnectionContract,
  type InfrastructureCapabilities,
  type RunnerPoolConnection,
} from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { apiFailure } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { infrastructureCapabilities } from '~/stories/infra.stories.mocks'
import {
  kubernetesEnvironmentDescriptor,
  kubernetesRunnerConnection,
  kubernetesRunnerDescriptor,
} from '~/stories/providers.stories.mocks'
import { environmentConnectionApi, runnerPoolConnectionApi } from '~/stories/setupApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import { useProviderConnectionsStore } from '~/stores/providerConnections'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import InfrastructureBackendPicker from './InfrastructureBackendPicker.vue'

// One list per infrastructure axis: where agent containers run, or where the Tester's
// environments run. Each item is a destination: the deployment's built-in, then each backend kind
// it registered. Picking a pool or a cluster shows its connect form under the list, which is the
// `ProviderConnectionTab` story. On a local deployment the choice of where agents run is a real
// setting of the board, and on Kubernetes the list adds a local k3s item. Elsewhere the
// deployment and the stored connection decide, so the list only shows the forms, and a line
// states what is active. The Infrastructure window has probed the two providers when the picker
// shows, so each story seeds what that probe found, and answers the reads the connect form sends.

/** Agents on Cloudflare Containers, with a runner pool offered beside them: a Worker deployment. */
const worker = infrastructureCapabilities({
  execution: {
    available: ['cloudflare-containers', 'runner-pool'],
    active: 'cloudflare-containers',
  },
  testEnv: { available: ['environment-provider'], active: 'environment-provider' },
})

/**
 * The picker on a deployment that offers `capabilities`, local or not, where the probe found the
 * runner pool with `connection`, or the environment provider not connected.
 */
function deployment(
  capabilities: InfrastructureCapabilities,
  options: { local?: boolean; connection?: RunnerPoolConnection | null; delegated?: boolean } = {},
) {
  return withSeed(() => {
    seedWorkspace()
    const auth = useAuthStore()
    auth.infrastructure = capabilities
    if (options.local) {
      auth.localMode = { enabled: true, patLogin: { configured: [], installable: [] } }
    }
    useWorkspaceSettingsStore().settings.delegateAgentsToRunnerPool = options.delegated ?? false
    const providers = useProviderConnectionsStore()
    providers.state['runner-pool'].available = true
    providers.state['runner-pool'].connection = options.connection ?? null
    providers.state.environment.available = true
  })
}

/** A local deployment, which names its executor image for the k3s form. */
const local = infrastructureCapabilities({
  execution: {
    available: ['local-docker', 'runner-pool'],
    active: 'local-docker',
    suggestedExecutorImage: 'ghcr.io/kibertoad/cat-factory-executor:1.163.4',
  },
})

const notConnected = runnerPoolConnectionApi({
  descriptor: kubernetesRunnerDescriptor(false),
})

const meta = {
  title: 'Settings/Components/InfrastructureBackendPicker',
  component: InfrastructureBackendPicker,
  args: { axis: 'execution' },
  decorators: [deployment(worker)],
  parameters: { width: 'prose', api: notConnected },
} satisfies Meta<typeof InfrastructureBackendPicker>
export default meta

type Story = StoryObj<typeof meta>

/** A Worker deployment with no pool connected: Cloudflare Containers is active and picked. */
export const Default: Story = {}

/**
 * The Acme build cluster connected: Kubernetes is active and picked, and its form shows the
 * stored connection.
 */
export const ConnectedPool: Story = {
  decorators: [deployment(worker, { connection: kubernetesRunnerConnection })],
  parameters: {
    api: runnerPoolConnectionApi({
      descriptor: kubernetesRunnerDescriptor(true),
      connection: kubernetesRunnerConnection,
    }),
  },
}

/**
 * Where test environments run, with no provider connected and Kubernetes picked: the HTTP
 * provider, Kubernetes and Cloudflare Workers, and the Kubernetes environment form.
 */
export const TestEnvAxis: Story = {
  args: { axis: 'testEnv' },
  parameters: {
    api: environmentConnectionApi({ descriptor: kubernetesEnvironmentDescriptor }),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await screen.findByRole('radio', { name: /Kubernetes cluster/ }))
    await within(canvasElement).findByText('API server URL')
  },
}

/** A local deployment: Local Docker picked, no active line, and the local k3s item last. */
export const LocalMode: Story = {
  decorators: [deployment(local, { local: true })],
}

/**
 * Local k3s picked with no cluster connected: the hint to register one first, and the form
 * filled in for a local cluster, the deployment's executor image too. The board still runs agents on Local Docker until a cluster is
 * connected.
 */
export const RegisterHint: Story = {
  decorators: [deployment(local, { local: true })],
  play: async ({ canvasElement }) => {
    await userEvent.click(await screen.findByRole('radio', { name: /Local Kubernetes/ }))
    await within(canvasElement).findByText('Register a runner pool below to enable this.')
  },
}

/** The runner pool's read failed, so the deployment offers its built-in only. */
export const PoolUnavailable: Story = {
  decorators: [
    withSeed(() => {
      useProviderConnectionsStore().state['runner-pool'].available = false
    }),
  ],
  parameters: {
    api: [
      apiFailure(describeRunnerPoolProviderContract, { pathPrefix: storyWorkspacePrefix }),
      apiFailure(getRunnerPoolConnectionContract, { pathPrefix: storyWorkspacePrefix }),
    ],
  },
}
