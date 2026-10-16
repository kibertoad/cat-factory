import type { Meta, StoryObj } from '@storybook/vue3'
import { listProvisioningLogsContract, type ProvisioningLogEntry } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import {
  kubernetesEnvironmentDescriptor,
  kubernetesRunnerConnection,
  kubernetesRunnerDescriptor,
  manifestRunnerDescriptor,
  runnerPoolConnection,
} from '~/stories/providers.stories.mocks'
import { environmentConnectionApi, runnerPoolConnectionApi } from '~/stories/setupApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
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
  },
}
