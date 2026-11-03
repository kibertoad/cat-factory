import { listEnvironmentsContract } from '@cat-factory/contracts'
import type { EnvironmentHandle, FrontendConfig } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import FrontendBindingsResolved from './FrontendBindingsResolved.vue'

// Where each of a frontend's backend env vars points: a bound service's live environment URL
// (green), a bound service with no live environment (amber), or the mock (grey). In the inspector
// it resolves against the workspace's current environments, which it loads itself. In a test
// run's detail it is given the bindings the run started with instead. A frontend with no bindings
// renders nothing, so there is no story for it.
const config: FrontendConfig = {
  backendBindings: [
    { envVar: 'VITE_AUTH_URL', source: { kind: 'service', serviceBlockId: 'svc_auth' } },
    { envVar: 'VITE_GATEWAY_URL', source: { kind: 'service', serviceBlockId: 'svc_gateway' } },
    { envVar: 'VITE_PAYMENTS_URL', source: { kind: 'mock' } },
  ],
}

const authEnvironment: EnvironmentHandle = {
  id: 'env_auth_42',
  workspaceId: STORY_WORKSPACE_ID,
  blockId: 'task_login',
  frameId: 'svc_auth',
  executionId: null,
  providerId: 'preview',
  externalId: null,
  url: 'https://auth-pr-42.preview.example.invalid',
  status: 'ready',
  createdAt: Date.UTC(2026, 9, 11, 9, 0, 0),
  expiresAt: null,
  lastError: null,
}

const meta = {
  title: 'Inspector/Components/FrontendBindingsResolved',
  component: FrontendBindingsResolved,
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      seedWorkspace()
    }),
  ],
  parameters: {
    width: 'panel',
    api: [
      apiResponse(listEnvironmentsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: [authEnvironment],
      }),
    ],
  },
} satisfies Meta<typeof FrontendBindingsResolved>
export default meta

type Story = StoryObj<typeof meta>

/** Live: Auth Service has an environment, API Gateway has none, payments is mocked. */
export const Default: Story = { args: { config } }

/** The same env var bound twice: a warning names it, and the last binding wins. */
export const DuplicateEnvVar: Story = {
  args: {
    config: {
      backendBindings: [
        ...config.backendBindings,
        { envVar: 'VITE_AUTH_URL', source: { kind: 'mock' } },
      ],
    },
  },
}

/** A finished run: the bindings it started with, whatever the environments are now. */
export const Projected: Story = {
  args: {
    config,
    resolved: [
      { envVar: 'VITE_AUTH_URL', serviceUrl: 'https://auth-pr-40.preview.example.invalid' },
      { envVar: 'VITE_GATEWAY_URL' },
      { envVar: 'VITE_PAYMENTS_URL' },
    ],
  },
}
