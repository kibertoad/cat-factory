import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getCapabilityCredentialsContract,
  getLocalSettingsContract,
  listEnvironmentHandlersContract,
  listPackageRegistriesContract,
  listToolServersContract,
  type InfrastructureCapabilities,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiFailure, apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import {
  declaredCapabilityCredentials,
  kubernetesHandler,
  kubernetesTestPassed,
  localCapabilities,
  localSettings,
  packageRegistryEntries,
  registeredManifestType,
  workerCapabilities,
} from '~/stories/infra.stories.mocks'
import {
  kubernetesEnvironmentDescriptor,
  kubernetesRunnerConnection,
  kubernetesRunnerDescriptor,
} from '~/stories/providers.stories.mocks'
import {
  environmentConnectionApi,
  environmentHandlersApi,
  environmentHandlerTestApi,
  runnerPoolConnectionApi,
} from '~/stories/setupApi'
import { seedMember, seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import { useUiStore } from '~/stores/ui'
import type { InfrastructureTab } from '~/types/providerConnections'
import InfrastructureWindow from './InfrastructureWindow.vue'

// The Infrastructure window, opened from the navbar: where agent containers run, where the
// Tester's environments run, the shared stacks those environments join, the private package
// registries a checkout installs from, and the credentials the deployment's tools want. The
// deployment's reported backends decide the first three tabs. The registries tab shows only when
// that module answers, and the credentials tab only for a person who may manage secrets and when
// there is something to show. So the window probes both providers, the registries and the
// credentials when it opens, and each story answers those reads and the reads of the tab it
// opens on. Each tab's sections have their own stories.

const pathPrefix = storyWorkspacePrefix

/**
 * The window opened on `tab` on a deployment that reports `capabilities`, local or not. With no
 * access seeded every permission holds, as on a deployment with sign-in off; `member` makes the
 * viewer a member of the board, with the backend's permissions for that role.
 */
function opened(
  tab: InfrastructureTab,
  capabilities: InfrastructureCapabilities | null,
  options: { local?: boolean; member?: boolean } = {},
) {
  return withSeed(() => {
    seedWorkspace()
    if (options.member) seedMember()
    const auth = useAuthStore()
    auth.infrastructure = capabilities
    if (options.local) {
      auth.localMode = { enabled: true, patLogin: { configured: [], installable: [] } }
    }
    useUiStore().openInfrastructure(tab)
  })
}

/** The registries and the credentials the window probes, both with something to show. */
const modules: HttpHandler[] = [
  apiResponse(listPackageRegistriesContract, {
    pathPrefix,
    body: { entries: packageRegistryEntries },
  }),
  apiResponse(getCapabilityCredentialsContract, {
    pathPrefix,
    body: {
      declared: declaredCapabilityCredentials,
      orphaned: [],
      environmentFallback: false,
      declarationsIncomplete: false,
    },
  }),
  apiResponse(listToolServersContract, { pathPrefix, body: { servers: [] } }),
]

/** The Acme build cluster runs agents; no test environment provider is connected. */
const providers: HttpHandler[] = [
  ...runnerPoolConnectionApi({
    descriptor: kubernetesRunnerDescriptor(true),
    connection: kubernetesRunnerConnection,
  }),
  ...environmentConnectionApi({ descriptor: kubernetesEnvironmentDescriptor }),
]

const meta = {
  title: 'Settings/Pages/InfrastructureWindow',
  component: InfrastructureWindow,
  decorators: [opened('runner-pool', workerCapabilities)],
  parameters: { api: [...providers, ...modules] },
} satisfies Meta<typeof InfrastructureWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A Worker deployment: the five tabs, and Agent containers open with the Acme build cluster
 * connected.
 */
export const Default: Story = {}

/**
 * The Test environments tab: the default provision type, the staging cluster tested at once with
 * one custom type, and the guided Docker Compose setup.
 */
export const TestEnvironments: Story = {
  decorators: [opened('environment', workerCapabilities)],
  parameters: {
    api: [
      ...providers,
      ...modules,
      environmentHandlersApi([kubernetesHandler], [registeredManifestType]),
      environmentHandlerTestApi(kubernetesTestPassed),
    ],
  },
}

/**
 * The Test environments tab when the handler read fails: the configurator is gone, and nothing
 * says why. The store reads any failure as the integration being off.
 */
export const HandlersFailed: Story = {
  decorators: [opened('environment', workerCapabilities)],
  parameters: {
    api: [...providers, ...modules, apiFailure(listEnvironmentHandlersContract, { pathPrefix })],
  },
}

/**
 * A local deployment with no cluster connected: Local Docker, the local k3s item, and the warm
 * container pool and checkout reuse under them.
 */
export const LocalMode: Story = {
  decorators: [opened('runner-pool', localCapabilities, { local: true })],
  parameters: {
    api: [
      ...runnerPoolConnectionApi({ descriptor: kubernetesRunnerDescriptor(false) }),
      ...environmentConnectionApi({ descriptor: kubernetesEnvironmentDescriptor }),
      ...modules,
      apiResponse(getLocalSettingsContract, { body: localSettings }),
    ],
  },
}

/**
 * A member of the board, who may not manage secrets: no credentials tab, and the credentials are
 * not read.
 */
export const MemberWithoutSecrets: Story = {
  decorators: [opened('runner-pool', workerCapabilities, { member: true })],
}

/**
 * Nothing to show: the deployment's backends are not known yet, and the registries and the
 * credentials modules are not configured (both answer 503).
 */
export const NoneAvailable: Story = {
  decorators: [opened('runner-pool', null)],
  parameters: {
    api: [
      ...providers,
      apiRefusal(listPackageRegistriesContract, {
        pathPrefix,
        status: 503,
        error: {
          code: 'unavailable',
          message: 'The package-registry integration is not configured',
        },
      }),
      apiRefusal(getCapabilityCredentialsContract, {
        pathPrefix,
        status: 503,
        error: {
          code: 'unavailable',
          message: 'The capability-credential store is not configured (needs ENCRYPTION_KEY)',
        },
      }),
      apiResponse(listToolServersContract, { pathPrefix, body: { servers: [] } }),
    ],
  },
}
