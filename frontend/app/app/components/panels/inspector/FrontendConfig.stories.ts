import type { Meta, StoryObj } from '@storybook/vue3'
import type { FrontendConfig, FrontendConfigRecommendation } from '@cat-factory/contracts'
import {
  detectFrontendConfigContract,
  getPreviewContract,
  listEnvironmentsContract,
} from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { block } from '~/stories/block.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { infrastructureCapabilities } from '~/stories/infra.stories.mocks'
import { authRepo, authServiceRow, githubConnection } from '~/stories/vcs.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import { useGitHubStore } from '~/stores/github'
import { useServicesStore } from '~/stores/services'
import type { Block } from '~/types/domain'
import FrontendConfigPanel from './FrontendConfig.vue'

// A frontend frame's settings: how to build, serve and mock it for a self-contained UI test, the
// variables that point it at a backend (a service frame's environment, or the mock), and an
// optional preview a person can open. Detect from repo reads the linked repository and proposes
// most of it; nothing is saved until Apply. The section and its six groups start closed, so each
// story opens the section and the group it is about. The web app, its repository and the
// detection notes are made up; the detect failure is the backend's own wording.
const WEB_REPO_ID = 4815

const pathPrefix = storyWorkspacePrefix

const configured: FrontendConfig = {
  packageManager: 'pnpm',
  directory: 'apps/web',
  buildScript: 'build',
  outputDir: 'dist',
  serveMode: 'static',
  envInjection: 'build',
  backendBindings: [
    { envVar: 'VITE_AUTH_URL', source: { kind: 'service', serviceBlockId: 'svc_auth' } },
    { envVar: 'VITE_PAYMENTS_URL', source: { kind: 'mock' } },
  ],
}

function webFrame(frontendConfig?: FrontendConfig): Block {
  return block({
    id: 'fe_web',
    title: 'Web app',
    level: 'frame',
    type: 'frontend',
    parentId: null,
    ...(frontendConfig ? { frontendConfig } : {}),
  })
}

/** The web frame on the shared board, linked to its own repository. */
function seeded(frame: Block, options: { previewSupported?: boolean } = {}) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard([...boardBlocks, frame])
    const github = useGitHubStore()
    github.connection = githubConnection
    github.repos = [authRepo, { ...authRepo, githubId: WEB_REPO_ID, name: 'web' }]
    useServicesStore().hydrate(
      [],
      [
        authServiceRow,
        { ...authServiceRow, id: 'service_web', frameBlockId: frame.id, repoGithubId: WEB_REPO_ID },
      ],
    )
    useAuthStore().infrastructure = infrastructureCapabilities({
      frontendPreview: { supported: options.previewSupported !== false },
    })
  })
}

/** Open the section, then the named group inside it. */
async function open(canvasElement: HTMLElement, group?: string) {
  const canvas = within(canvasElement)
  await userEvent.click(canvas.getByRole('button', { name: /^Frontend/ }))
  if (group) await userEvent.click(await canvas.findByRole('button', { name: new RegExp(group) }))
}

async function detect(canvasElement: HTMLElement) {
  await open(canvasElement)
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Detect' }))
}

const recommendation: FrontendConfigRecommendation = {
  detected: true,
  config: {
    packageManager: 'pnpm',
    buildScript: 'build',
    outputDir: 'dist',
    serveMode: 'static',
    backendBindings: [{ envVar: 'VITE_API_URL', source: { kind: 'mock' } }],
  },
  notes: [
    { field: 'packageManager', confidence: 'high', message: 'pnpm-lock.yaml present ⇒ pnpm' },
    {
      field: 'outputDir',
      confidence: 'high',
      message: 'vite.config.ts has no build.outDir ⇒ dist',
    },
    {
      field: 'backendBindings',
      confidence: 'low',
      message: 'VITE_API_URL read in src/api/client.ts; bind it to a service to test against one',
    },
  ],
}

const liveEnvironments = apiResponse(listEnvironmentsContract, { pathPrefix, body: [] })

const meta = {
  title: 'Inspector/Components/FrontendConfig',
  component: FrontendConfigPanel,
  args: { block: webFrame(configured) },
  decorators: [seeded(webFrame(configured))],
  parameters: { width: 'panel', api: [liveEnvironments] },
} satisfies Meta<typeof FrontendConfigPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Two bindings: the auth variable to Auth Service's environment, which has none live, and the
 * payments variable to the mock.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    await open(canvasElement, 'Backend bindings')
    await within(canvasElement).findByDisplayValue('VITE_AUTH_URL')
  },
}

/** Nothing set yet: the bindings group's empty state. */
export const Empty: Story = {
  args: { block: webFrame() },
  decorators: [seeded(webFrame())],
  play: async ({ canvasElement }) => {
    await open(canvasElement, 'Backend bindings')
    await within(canvasElement).findByText(
      'No backend bindings. Add one to point an env var at a service or a mock.',
    )
  },
}

/** What Detect proposes: the notes with their confidence, then Apply and Dismiss. */
export const DetectProposal: Story = {
  args: { block: webFrame() },
  decorators: [seeded(webFrame())],
  parameters: {
    api: [
      liveEnvironments,
      apiResponse(detectFrontendConfigContract, { pathPrefix, body: recommendation }),
    ],
  },
  play: async ({ canvasElement }) => {
    await detect(canvasElement)
    await within(canvasElement).findByText('pnpm-lock.yaml present ⇒ pnpm')
  },
}

/** Nothing found: the hint to set the frontend's directory, with the Build group opened for it. */
export const DetectNothingFound: Story = {
  args: { block: webFrame() },
  decorators: [seeded(webFrame())],
  parameters: {
    api: [
      liveEnvironments,
      apiResponse(detectFrontendConfigContract, {
        pathPrefix,
        body: { detected: false, config: { backendBindings: [] }, notes: [] },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await detect(canvasElement)
    await within(canvasElement).findByText(
      'Nothing frontend-shaped was detected. Set the frontend directory (for a monorepo) or fill the fields in manually.',
    )
  },
}

/** The repository could not be read: translated copy, the backend's message behind "Show details". */
export const DetectError: Story = {
  args: { block: webFrame() },
  decorators: [seeded(webFrame())],
  parameters: {
    api: [
      liveEnvironments,
      apiRefusal(detectFrontendConfigContract, {
        pathPrefix,
        status: 422,
        error: {
          code: 'validation',
          message:
            'Could not read acme/web to auto-detect. Confirm the GitHub App still has "Contents: ' +
            'read" access to this repository (re-check the installation\'s repository access), ' +
            'that the branch exists, and that you are not rate-limited, then retry. Underlying ' +
            'error: Not Found',
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await detect(canvasElement)
    const canvas = within(canvasElement)
    // The translated copy first; the server's remedy only behind "Show details".
    await canvas.findByText(
      "Couldn't read the repo. Check the frontend is linked to a connected repository.",
    )
    await userEvent.click(canvas.getByTestId('failure-message-show-detail'))
    await canvas.findByText(/Underlying error: Not Found/)
  },
}

const withPreview = webFrame({ ...configured, previewEnabled: true })

/** The preview is up: its address, Open and Stop. */
export const PreviewReady: Story = {
  args: { block: withPreview },
  decorators: [seeded(withPreview)],
  parameters: {
    api: [
      liveEnvironments,
      apiResponse(getPreviewContract, {
        pathPrefix,
        pathParams: { frameId: 'fe_web' },
        body: {
          frameId: 'fe_web',
          status: 'ready',
          url: 'http://localhost:4321',
          updatedAt: Date.UTC(2026, 9, 14, 8, 30),
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await open(canvasElement, 'Preview')
    await within(canvasElement).findByTestId('preview-url')
  },
}

/** The preview build broke: the error, and Start to try again. The error is made up. */
export const PreviewFailed: Story = {
  args: { block: withPreview },
  decorators: [seeded(withPreview)],
  parameters: {
    api: [
      liveEnvironments,
      apiResponse(getPreviewContract, {
        pathPrefix,
        pathParams: { frameId: 'fe_web' },
        body: {
          frameId: 'fe_web',
          status: 'failed',
          error: 'pnpm build exited with code 1: Cannot find module "@acme/ui"',
          updatedAt: Date.UTC(2026, 9, 14, 8, 30),
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await open(canvasElement, 'Preview')
    await within(canvasElement).findByTestId('preview-error')
  },
}

/** A deployment that cannot host a preview (the Worker): the switch is off, with the reason. */
export const PreviewUnsupported: Story = {
  decorators: [seeded(webFrame(configured), { previewSupported: false })],
  play: async ({ canvasElement }) => {
    await open(canvasElement, 'Preview')
    await within(canvasElement).findByText(/can't host a browsable preview/)
  },
}
