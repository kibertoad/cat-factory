import type { Meta, StoryObj } from '@storybook/vue3'
import { listProvisioningLogsContract, type ProvisioningLogEntry } from '@cat-factory/contracts'
import { expect, screen, userEvent, within } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import {
  accountRunnerPool,
  inheritedRunnerConnection,
  kubernetesEnvironmentDescriptor,
  kubernetesRunnerConnection,
  kubernetesRunnerDescriptor,
  manifestRunnerDescriptor,
  runnerPoolConnection,
} from '~/stories/providers.stories.mocks'
import { environmentConnectionApi, runnerPoolConnectionApi } from '~/stories/setupApi'
import { seedUiMode, seedWorkspace, withSeed } from '~/stories/withStores'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import ProviderConnectionTab from './ProviderConnectionTab.vue'

// The connect surface for one infrastructure provider: the runner pool that runs agent
// containers, or the provider of test environments. The picker above it chooses the backend
// kind. The panel reads how that backend describes itself and the board's stored connection when
// it opens, so each story answers those reads. A backend that ships a template gets a flat form
// built from its fields (the Kubernetes runner); one without gets the manifest editor (an HTTP
// runner pool); the Kubernetes environment backend has a form of its own. Those forms' own states
// are in their own stories.

const meta = {
  title: 'Settings/Components/ProviderConnectionTab',
  component: ProviderConnectionTab,
  args: { kind: 'runner-pool', backendKind: 'kubernetes' },
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: runnerPoolConnectionApi({
      descriptor: kubernetesRunnerDescriptor(true),
      connection: kubernetesRunnerConnection,
    }),
  },
} satisfies Meta<typeof ProviderConnectionTab>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Agent containers on the Acme build cluster: the stored connection, and the flat form filled in
 * from it, with the note that the token must be typed again to save.
 */
export const Default: Story = {}

/**
 * No cluster connected yet: the warning naming every required field, the empty form, and Connect
 * disabled.
 */
export const Empty: Story = {
  parameters: {
    api: runnerPoolConnectionApi({ descriptor: kubernetesRunnerDescriptor(false) }),
  },
}

/** The Acme HTTP runner pool, connected from a manifest: the manifest editor with it. */
export const ManifestDriven: Story = {
  args: { backendKind: 'manifest' },
  parameters: {
    api: runnerPoolConnectionApi({
      descriptor: manifestRunnerDescriptor,
      connection: runnerPoolConnection,
    }),
  },
}

/** How the Kubernetes backend describes the account's shared cluster, which the board inherits. */
const inheritedDescriptor = {
  ...kubernetesRunnerDescriptor(true),
  label: inheritedRunnerConnection.label,
  values: {
    label: 'Acme shared cluster',
    apiServerUrl: 'https://k8s.shared.acme.dev:6443',
    namespace: 'cat-factory-shared',
    image: 'ghcr.io/kibertoad/cat-factory-executor:1.163.4',
  },
}

/**
 * The board has no pool of its own and uses its account's, the Acme shared cluster: the summary
 * says so and has no remove button, and the form offers a pool of the board's own instead. In
 * basic mode the opt-out is not offered, because it overrides the account's default.
 */
export const InheritedFromAccount: Story = {
  parameters: {
    api: runnerPoolConnectionApi({
      descriptor: inheritedDescriptor,
      connection: inheritedRunnerConnection,
      accountPool: accountRunnerPool,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('Account pool')
    await expect(canvas.queryByRole('button', { name: 'Stop using the account pool' })).toBeNull()
  },
}

/** The same inherited pool in advanced mode: the board can stop using the account's pool. */
export const InheritedAdvanced: Story = {
  ...InheritedFromAccount,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedUiMode('advanced')
    }),
  ],
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: 'Stop using the account pool' })
  },
}

/**
 * The board's own cluster, with the account's pool beside it: before removing its own, the admin
 * chooses whether the board then uses the account's pool. Unticked, it uses none.
 */
export const OwnPoolBesideAccount: Story = {
  parameters: {
    api: runnerPoolConnectionApi({
      descriptor: kubernetesRunnerDescriptor(true),
      connection: kubernetesRunnerConnection,
      accountPool: accountRunnerPool,
    }),
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('checkbox', {
      name: "When I remove this board's pool, use the account pool",
    })
  },
}

/**
 * The board opted out of its account's pool and has none of its own: it names the account's pool
 * and offers to use it again, in every mode.
 */
export const OptedOutOfAccount: Story = {
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useWorkspaceSettingsStore().settings.inheritAccountRunnerPool = false
    }),
  ],
  parameters: {
    api: runnerPoolConnectionApi({
      descriptor: kubernetesRunnerDescriptor(false),
      accountPool: accountRunnerPool,
    }),
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: 'Use the account pool' })
  },
}

/** Test environments on a Kubernetes cluster, not connected yet: the token is missing. */
export const KubernetesEnvironment: Story = {
  args: { kind: 'environment', backendKind: 'kubernetes' },
  parameters: {
    api: environmentConnectionApi({ descriptor: kubernetesEnvironmentDescriptor }),
  },
}

/**
 * The local k3s preset of the picker, on a first connect: the loopback apiserver, the namespace,
 * the TLS skip and the deployment's executor image filled in. Only the token is left.
 */
export const K3sPreset: Story = {
  args: {
    preset: 'k3s',
    suggestedImage: 'ghcr.io/kibertoad/cat-factory-executor:1.163.4',
  },
  parameters: {
    api: runnerPoolConnectionApi({ descriptor: kubernetesRunnerDescriptor(false) }),
  },
}

function runnerAttempt(
  id: string,
  minute: number,
  overrides: Partial<ProvisioningLogEntry>,
): ProvisioningLogEntry {
  return {
    id,
    workspaceId: STORY_WORKSPACE_ID,
    subsystem: 'runner-pool',
    operation: 'dispatch',
    targetId: 'cf-run-exec-login-coder',
    providerId: 'kubernetes',
    blockId: null,
    executionId: 'exec_login',
    outcome: 'success',
    error: null,
    detail: null,
    createdAt: Date.UTC(2026, 9, 11, 9, minute),
    ...overrides,
  }
}

/** The runner pool's attempts opened: a run's pod started and was released. */
export const LogsOpen: Story = {
  parameters: {
    api: [
      ...runnerPoolConnectionApi({
        descriptor: kubernetesRunnerDescriptor(true),
        connection: kubernetesRunnerConnection,
      }),
      apiResponse(listProvisioningLogsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: {
          entries: [
            runnerAttempt('pl_r2', 48, { operation: 'release' }),
            runnerAttempt('pl_r1', 31, {}),
          ],
        },
      }),
    ],
  },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'View logs' }))
    await screen.findByText('Tear down')
  },
}
