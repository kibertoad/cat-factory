import type { Meta, StoryObj } from '@storybook/vue3'
import type { PreflightResult, StackRecipe } from '@cat-factory/contracts'
import { runPreflightsContract } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiFailure, apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useEnvironmentWizardStore } from '~/stores/environmentWizard'
import EnvPreflightStep from './EnvPreflightStep.vue'

// The wizard step that runs the machine checks the service's recipe declares: Docker, disk,
// registry login and the like. Each result says pass, warn or fail, and a check that did not
// pass shows how to fix it. The checks only advise, so Next is always on. They read the host, so
// only a local deployment runs them; elsewhere the request is refused and the step says so.
//
// The step points the wizard store at its frame on mount, and a new frame resets the store and
// starts the repo detection. So the seed sets the frame first and the recipe after it. The
// results follow the backend's titles and remediation (`PreflightService` in integrations) and
// the local probes' details (`preflight.ts` in the local runtime); the registry is made up.
const recipe: StackRecipe = {
  prerequisites: [
    { check: 'docker-daemon' },
    { check: 'disk-space', params: { minGib: 20 } },
    { check: 'registry-auth', params: { registry: '412907.dkr.ecr.eu-west-1.amazonaws.com' } },
    { check: 'mkcert-ca', required: false },
  ],
}

const results: PreflightResult[] = [
  {
    check: 'docker-daemon',
    title: 'Docker daemon reachable',
    status: 'pass',
    required: true,
    detail: 'Docker 28.4.0',
  },
  {
    check: 'disk-space',
    title: 'Free disk space',
    status: 'pass',
    required: true,
    detail: '84.2 GiB free on /var/lib/docker',
  },
  {
    check: 'registry-auth',
    title: 'Container registry login',
    status: 'fail',
    required: true,
    detail: 'no docker login for 412907.dkr.ecr.eu-west-1.amazonaws.com',
    remediation:
      'Not logged in to `412907.dkr.ecr.eu-west-1.amazonaws.com`. Authenticate (e.g. `aws ecr ' +
      'get-login-password --region <r> | docker login --username AWS --password-stdin ' +
      '412907.dkr.ecr.eu-west-1.amazonaws.com`, or `docker login ' +
      '412907.dkr.ecr.eu-west-1.amazonaws.com`) and re-run. Registry tokens expire (ECR ~every ' +
      '12h), so refresh if it was working earlier.',
  },
  {
    check: 'mkcert-ca',
    title: 'mkcert local CA installed',
    status: 'warn',
    required: false,
    detail: 'mkcert did not report a CA root',
    remediation:
      'The mkcert local CA is not in the trust store. Install mkcert and run `mkcert -install`, then re-run.',
  },
]

function onFrame(declared: StackRecipe) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    const wizard = useEnvironmentWizardStore()
    wizard.frameId = authService.id
    wizard.recipe = declared
  })
}

/** Runs the checks, then waits for the block that the answer draws. */
async function runChecks(canvasElement: HTMLElement, outcome: string) {
  const canvas = within(canvasElement)
  await userEvent.click(canvas.getByTestId('env-setup-preflight-run'))
  await canvas.findByTestId(outcome)
}

const meta = {
  title: 'Setup/Components/EnvPreflightStep',
  component: EnvPreflightStep,
  args: { input: { frameId: authService.id }, exit: () => {}, goBack: () => {} },
  parameters: { width: 'prose' },
  decorators: [onFrame(recipe)],
} satisfies Meta<typeof EnvPreflightStep>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The four checks run: Docker and disk pass, the registry login fails with its fix, and the
 * optional mkcert check warns.
 */
export const Default: Story = {
  parameters: {
    api: [apiResponse(runPreflightsContract, { pathPrefix: storyWorkspacePrefix, body: results })],
  },
  play: async ({ canvasElement }) => runChecks(canvasElement, 'env-setup-preflight-results'),
}

/** The recipe declares no checks. */
export const Empty: Story = { decorators: [onFrame({})] }

/** Not a local deployment: the request is refused, and the step says the checks run locally. */
export const Unavailable: Story = {
  parameters: {
    api: [
      apiRefusal(runPreflightsContract, {
        pathPrefix: storyWorkspacePrefix,
        status: 503,
        error: {
          code: 'unavailable',
          message: 'Preflight checks are not available on this deployment',
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => runChecks(canvasElement, 'env-setup-preflight-unavailable'),
}

/** The request failed: the step shows the backend's message as it came. */
export const LoadFailed: Story = {
  parameters: { api: [apiFailure(runPreflightsContract, { pathPrefix: storyWorkspacePrefix })] },
  play: async ({ canvasElement }) => runChecks(canvasElement, 'env-setup-preflight-error'),
}
