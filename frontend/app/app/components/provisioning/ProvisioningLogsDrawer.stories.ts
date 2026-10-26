import type { Meta, StoryObj } from '@storybook/vue3'
import type { ProvisioningLogEntry } from '@cat-factory/contracts'
import { listProvisioningLogsContract } from '@cat-factory/contracts'
import { expect, userEvent, within } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import ProvisioningLogsDrawer from './ProvisioningLogsDrawer.vue'

// Every attempt to start or stop infrastructure, newest first, with its outcome and, for a
// failure, the provider's own error. It serves two places: a run's "Infrastructure attempts"
// (by run id), and the logs of an environment provider or runner pool panel (by subsystem). The
// drawer loads the attempts itself. The row shapes follow the backend's writers
// (`EnvironmentProvisioningService.ts` and `LoggingRunnerTransport.ts` in integrations); the
// Kubernetes error and the container capacity error are made up.

function entry(
  id: string,
  minute: number,
  overrides: Partial<ProvisioningLogEntry>,
): ProvisioningLogEntry {
  return {
    id,
    workspaceId: STORY_WORKSPACE_ID,
    subsystem: 'container',
    operation: 'dispatch',
    targetId: 'exec_login-coder',
    providerId: null,
    blockId: null,
    executionId: 'exec_login',
    outcome: 'success',
    error: null,
    detail: null,
    createdAt: Date.UTC(2026, 9, 11, 9, minute),
    ...overrides,
  }
}

/**
 * The login run's attempts, newest first: the first coder container was refused for capacity and
 * the retry started; the preview environment came up on Kubernetes; the architect's container
 * started and stopped.
 */
const runAttempts: ProvisioningLogEntry[] = [
  entry('pl_6', 31, {}),
  entry('pl_5', 30, {
    outcome: 'failure',
    error: 'Container dispatch failed (HTTP 503): no capacity',
  }),
  entry('pl_4', 24, {
    subsystem: 'environment',
    operation: 'provision',
    targetId: 'env_login_preview',
    providerId: 'kubernetes',
    blockId: 'task_login',
  }),
  entry('pl_3', 12, { operation: 'release', targetId: 'exec_login-architect' }),
  entry('pl_2', 2, { targetId: 'exec_login-architect' }),
]

/** An environment provider's attempts across runs, with a refused one. */
const environmentAttempts: ProvisioningLogEntry[] = [
  entry('pe_3', 40, {
    subsystem: 'environment',
    operation: 'teardown',
    targetId: 'env_refresh_preview',
    providerId: 'kubernetes',
    executionId: 'exec_refresh',
  }),
  entry('pe_2', 24, {
    subsystem: 'environment',
    operation: 'provision',
    targetId: 'env_login_preview',
    providerId: 'kubernetes',
  }),
  entry('pe_1', 8, {
    subsystem: 'environment',
    operation: 'provision',
    targetId: null,
    providerId: 'kubernetes',
    executionId: 'exec_logout',
    outcome: 'failure',
    error:
      'namespaces "cf-logout-preview" is forbidden: exceeded quota: preview-quota, ' +
      'requested: limits.memory=2Gi, used: limits.memory=15Gi, limited: limits.memory=16Gi',
  }),
]

function entriesAre(entries: ProvisioningLogEntry[]) {
  return apiResponse(listProvisioningLogsContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { entries },
  })
}

const meta = {
  title: 'Run telemetry/Components/ProvisioningLogsDrawer',
  component: ProvisioningLogsDrawer,
  args: { executionId: 'exec_login', live: false },
  decorators: [withSeed(seedWorkspace)],
  parameters: { width: 'panel', api: [entriesAre(runAttempts)] },
} satisfies Meta<typeof ProvisioningLogsDrawer>
export default meta

type Story = StoryObj<typeof meta>

/** A finished run's five attempts, newest first, one refused for capacity with its error. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findAllByRole('listitem')).toHaveLength(5)
  },
}

/** The first load in flight: placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(listProvisioningLogsContract, { pathPrefix: storyWorkspacePrefix })],
  },
}

/** The read failed: a translated message in place of the attempts. */
export const Failed: Story = {
  parameters: {
    api: [apiFailure(listProvisioningLogsContract, { pathPrefix: storyWorkspacePrefix })],
  },
  // The server's own text shows only behind "Show details".
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('The provisioning logs could not be loaded.')
    await expect(canvas.queryByText(/500 Internal Server Error/)).toBeNull()
    await userEvent.click(canvas.getByTestId('failure-message-show-detail'))
    await expect(canvas.getByTestId('failure-message-detail')).toHaveTextContent(
      /500 Internal Server Error/,
    )
  },
}

/** Nothing started yet: the drawer shows its empty state. */
export const Empty: Story = {
  parameters: { api: [entriesAre([])] },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('No provisioning attempts recorded yet.')
  },
}

/**
 * The environment provider panel's drawer: its attempts across runs, each with its
 * outcome and target, one refused by the namespace's memory quota with the provider's error.
 */
export const Subsystem: Story = {
  args: { executionId: undefined, live: undefined, subsystem: 'environment' },
  parameters: { api: [entriesAre(environmentAttempts)] },
}
