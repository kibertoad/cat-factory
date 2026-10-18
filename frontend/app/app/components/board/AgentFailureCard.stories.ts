import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, spyOn, userEvent, within } from 'storybook/test'
import type { AgentFailure } from '@cat-factory/contracts'
import { BILLING_FRAME_ID, bootstrapJob, failedApplyJob } from '~/stories/bootstrap.stories.mocks'
import {
  authService,
  boardBlocks,
  boardWith,
  loginTask,
  logoutTask,
} from '~/stories/board.stories.mocks'
import { execution } from '~/stories/snapshot.stories.mocks'
import { failure } from '~/stories/pipelineStep.stories.mocks'
import { seedBoard, seedViewer, withSeed } from '~/stories/withStores'
import { useAgentRunsStore, type AgentRunSummary } from '~/stores/agentRuns'
import { useAuthStore } from '~/stores/auth'
import { useExecutionStore } from '~/stores/execution'
import AgentFailureCard from './AgentFailureCard.vue'

// The one failure block of a task view (board card, queue card, inspector, focus view) and of a
// service frame, for a failed task run or a failed bootstrap. The title follows the failure kind,
// the cause line is the SPA's own translated copy (`presentFailure`), and the block offers one
// action: Retry, or the settings that fix the cause. The backend's message, its hint and the full
// output are behind Details. The hints are the backend's own wording for each kind
// (`EXECUTION_FAILURE_HINTS` in `RunStateMachine.ts`, `FAILURE_HINTS` in `BootstrapService.ts`).
// The provider errors and messages are made up. Retry calls the unified retry, which no story
// answers.
const meta = {
  title: 'Board/Components/AgentFailureCard',
  component: AgentFailureCard,
  parameters: { width: 'panel' },
  args: {
    run: taskRun(
      failure({
        kind: 'evicted',
        message: 'The container was evicted after 14 minutes of work and could not be recovered.',
        detail: 'exit code 137\nkilled: out of memory after 14m02s',
        hint:
          'The implementation container kept vanishing mid-run even after automatic ' +
          'fresh-container restarts. Most often this is transient: a deploy / new-version ' +
          'rollout draining the container, in which case simply retrying once the rollout has ' +
          'finished succeeds. If it persists, it points at a memory or crash issue on the run — ' +
          'inspect its logs (Cloudflare Workers Observability, filtered by the run id) and ' +
          'consider a heavier container instance type. Retry to try again.',
      }),
    ),
  },
  decorators: [withSeed(() => seedBoard(boardBlocks))],
} satisfies Meta<typeof AgentFailureCard>
export default meta

type Story = StoryObj<typeof meta>

/** The coarse run summary a card reads, for a failed run of the login task. */
function taskRun(f: AgentFailure): AgentRunSummary {
  return {
    blockId: loginTask.id,
    kind: 'execution',
    status: 'failed',
    runId: 'exec_login',
    failure: f,
    failureHistory: [],
    subtasks: null,
  }
}

const dispatchHint =
  'The agent’s container could not be started — the run never began executing. The ' +
  'provider/runtime’s verbatim response is shown below. Most often this is transient (a ' +
  'capacity blip or a new-version rollout); retrying spins a fresh container. If it persists it ' +
  'points at a misconfigured container binding/image or runner pool. Retry to try again.'

const environmentHint =
  'The deployer step could not provision its ephemeral environment — the environment provider ' +
  'failed, so the run never reached the steps that need it. The provider’s verbatim error is ' +
  'shown below. Most often this is a transient provider/network blip (retrying re-runs the ' +
  'provisioning) or a misconfigured provider connection / repo config. Fix the cause if it ' +
  'persists, then retry.'

/** The backend's message when a service's provider needs a deploy runner and none is wired. */
const deployRunnerUnwired =
  "This service's environment provider needs a container-backed deploy to render and apply its " +
  'manifests, but this deployment has no deploy runner wired to run it. Wire a deploy runner ' +
  'for this deployment:\n' +
  '  • Local mode — set LOCAL_DEPLOY_RUNTIME to `container` (runs the deploy-harness image per ' +
  'job; the image is resolved automatically, so no other variable is needed) or `native` ' +
  '(renders with your own host kubectl/kustomize/helm; also set LOCAL_DEPLOY_HARNESS_ENTRY). It ' +
  'has no default — pick one.\n' +
  '  • Node — register a self-hosted runner pool (it runs the deploy-harness image).\n' +
  '  • Cloudflare — add the DeployContainer binding.\n' +
  'Or use an environment config that provisions without a deploy container (raw manifests, or ' +
  'an infraless service).'

/** An evicted container: the title, the cause line, Retry run, and Details closed. */
export const Default: Story = {}

/** Details open: the backend's message, its notes for the operator, and the full output. */
export const DetailsOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }))
    await canvas.findByText(/killed: out of memory/)
    await expect(canvas.getByText('Notes for the operator')).toBeVisible()
  },
}

/** The compact variant, on the board card and the queue card: the title and Retry only. */
export const Compact: Story = {
  args: { variant: 'compact' },
  parameters: { width: 'narrow' },
}

/** The container never started: a temporary cause, so the action is Retry run. */
export const DispatchFailure: Story = {
  args: {
    run: taskRun(
      failure({
        kind: 'dispatch',
        message: 'The container failed to start.',
        detail: 'Runner pool answered HTTP 503: no capacity in pool acme-runners (0 of 8 free).',
        hint: dispatchHint,
      }),
    ),
  },
}

/**
 * The environment provider failed. That is most often a temporary provider fault, so Retry run
 * leads, and the environment setup is beside it for the case where a setting is the cause.
 */
export const EnvironmentFailure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('agent-failure-retry')).toBeEnabled()
    await expect(canvas.getByTestId('agent-failure-setup')).toBeVisible()
  },
  args: {
    run: taskRun(
      failure({
        kind: 'environment',
        message: 'Acme preview environments answered 502 while creating auth-pr-412.',
        detail: 'POST https://previews.acme.dev/api/environments → 502 Bad Gateway',
        hint: environmentHint,
      }),
    ),
  },
}

/**
 * Local mode, and the service deploys to Kubernetes with no deploy runner wired: no settings tab
 * fixes it, so the cause line names the .env fix, the variables show under it, and the action is
 * Retry, for after they are set.
 */
export const DeployRunnerUnwiredLocal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('agent-failure-environment-local-hint')).toBeVisible()
    await expect(canvas.getByTestId('agent-failure-retry')).toBeVisible()
    await expect(canvas.queryByTestId('agent-failure-setup')).toBeNull()
  },
  args: {
    run: taskRun(
      failure({
        kind: 'environment',
        reason: 'deploy_runner_unwired',
        message: deployRunnerUnwired,
        detail: deployRunnerUnwired,
        hint: environmentHint,
      }),
    ),
  },
  decorators: [
    withSeed(() => {
      seedBoard(boardWith({ ...authService, provisioning: { type: 'kubernetes' } }))
      useAuthStore().localMode = { enabled: true }
    }),
  ],
}

/** The run's driver was lost and recovery gave up. */
export const Stalled: Story = {
  args: {
    run: taskRun(
      failure({
        kind: 'stalled',
        message: 'Run stalled: no progress for 30 minutes and recovery could not resume it.',
        detail: null,
        hint:
          'This run stopped making progress — its durable driver was lost (most often a crashed ' +
          'or restarted orchestrator) and automatic recovery could not resume it in time, so it ' +
          'was flagged rather than left spinning. Retry to start a fresh run.',
      }),
    ),
  },
}

/**
 * No repository host connected: the run was refused before it started. The action connects the
 * host, because a retry fails again until it is connected.
 */
export const GithubNotConnected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('agent-failure-setup')).toHaveTextContent('Connect')
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }))
    await expect(await canvas.findByTestId('agent-failure-retry')).toBeEnabled()
  },
  args: {
    run: taskRun(
      failure({
        kind: 'preflight',
        reason: 'github_not_connected',
        message:
          "No connected GitHub repository found for workspace 'ws_story'. Connect the workspace " +
          'to GitHub and link a repository to this service before running an agent (Settings → ' +
          'GitHub). See https://github.com/kibertoad/cat-factory/blob/main/backend/docs/github-integration.md.',
        detail: null,
        hint:
          'A precondition failed before the agent’s container was started, so the run never ' +
          'began — most often the workspace has no connected GitHub repository, the selected ' +
          'model or provider isn’t configured, or a required credential is missing. The specific ' +
          'cause is shown above. Fix it (connect GitHub and link a repository, or pick a ' +
          'configured model in the workspace settings), then retry.',
      }),
    ),
  },
}

/**
 * A new-repository bootstrap refused before it started: Retry bootstrap, and Model activity in
 * Details, because a bootstrap has no steps to reach its model calls from.
 */
export const BootstrapFailure: Story = {
  args: {
    run: {
      blockId: BILLING_FRAME_ID,
      kind: 'bootstrap',
      status: 'failed',
      runId: 'boot_billing',
      failure: failure({
        kind: 'preflight',
        message:
          'Repository acme/billing already has content (src, package.json). Bootstrapping ' +
          "replaces the repository's contents, so it needs an empty repository, or one " +
          'prepopulated only with a README, .gitignore, license and/or AGENTS.md.',
        detail: null,
        hint:
          'Check the target repository exists under the connected account, is empty (or holds ' +
          'only README/.gitignore/license/AGENTS.md), and that the GitHub App is installed on it. ' +
          'Then retry.',
      }),
      failureHistory: [],
      subtasks: null,
    },
  },
  decorators: [
    withSeed(() => {
      useAgentRunsStore().bootstrapJobs = [
        bootstrapJob({ monorepo: null, phase: null, status: 'failed' }),
      ]
    }),
  ],
}

/**
 * A monorepo bootstrap that failed while writing the service: the step list, and a button that
 * resumes from that step, so the survey and the decisions are kept.
 */
export const BootstrapResume: Story = {
  args: {
    run: {
      blockId: BILLING_FRAME_ID,
      kind: 'bootstrap',
      status: 'failed',
      runId: 'boot_billing',
      failure: failedApplyJob().failure,
      failureHistory: [],
      subtasks: failedApplyJob().subtasks,
    },
  },
  decorators: [
    withSeed(() => {
      useAgentRunsStore().bootstrapJobs = [failedApplyJob()]
    }),
  ],
}

/** A board viewer: Retry is disabled, and its tooltip says why. */
export const ReadOnly: Story = {
  decorators: [withSeed(() => seedViewer())],
}

/** A run of the login task, on a pipeline that is not the task's default. */
const plannedRun = execution({ pipelineId: 'pl_story_plan', pipelineName: 'Story planning' })

/**
 * The run's saved state cannot be read, so a retry reads the same broken state: the action starts
 * a new run of the FAILED run's pipeline, not the task's default, and Retry waits in Details.
 */
export const StateUnreadable: Story = {
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      useExecutionStore().instances = [plannedRun]
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByTestId('agent-failure-retry')).toBeNull()
    const start = spyOn(useExecutionStore(), 'start').mockResolvedValue(true)
    await userEvent.click(canvas.getByTestId('agent-failure-new-run'))
    await expect(start).toHaveBeenCalledWith(loginTask.id, {
      id: 'pl_story_plan',
      name: 'Story planning',
    })
  },
  args: {
    run: taskRun(
      failure({
        kind: 'state_unreadable',
        message: 'The run row exec_login could not be decoded.',
        detail: null,
        hint:
          'This run’s stored state could not be read, so nothing can resume it: retrying would ' +
          're-read the same row. The run has been closed so it stops being re-driven; start the ' +
          'work again as a new run, and report the run id to whoever operates this deployment.',
      }),
    ),
  },
}

/**
 * The same failure on a task whose dependencies have not merged: a new run is refused in the
 * browser, as the card's Start is, and nothing is started.
 */
export const StateUnreadableBlocked: Story = {
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      useExecutionStore().instances = [{ ...plannedRun, id: 'exec_logout', blockId: logoutTask.id }]
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const start = spyOn(useExecutionStore(), 'start').mockResolvedValue(true)
    await userEvent.click(canvas.getByTestId('agent-failure-new-run'))
    await expect(start).not.toHaveBeenCalled()
  },
  args: {
    run: {
      ...taskRun(failure({ kind: 'state_unreadable', detail: null, hint: null })),
      blockId: logoutTask.id,
      runId: 'exec_logout',
    },
  },
}

/**
 * A run refused because no AI provider can serve a model in its pipeline: the action opens the AI
 * setup, with the same label and fix as the refusal's toast.
 */
export const ProvidersUnconfigured: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('agent-failure-setup')).toHaveTextContent('Configure AI')
  },
  args: {
    run: taskRun(
      failure({
        kind: 'preflight',
        reason: 'providers_unconfigured',
        message: 'No provider is configured for claude-sonnet-5-5.',
        detail: null,
        hint: null,
      }),
    ),
  },
}

/**
 * A board viewer on a failure a setting fixes: the setup button stays usable, and the Retry in
 * Details is disabled, as the main Retry is.
 */
export const ReadOnlySetupAction: Story = {
  args: GithubNotConnected.args,
  decorators: [withSeed(() => seedViewer())],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('agent-failure-setup')).toBeEnabled()
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }))
    await expect(await canvas.findByTestId('agent-failure-retry')).toBeDisabled()
  },
}
