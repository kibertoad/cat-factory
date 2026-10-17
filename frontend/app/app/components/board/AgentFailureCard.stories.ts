import type { Meta, StoryObj } from '@storybook/vue3'
import type { AgentFailure } from '@cat-factory/contracts'
import { BILLING_FRAME_ID, bootstrapJob, failedApplyJob } from '~/stories/bootstrap.stories.mocks'
import { authService, boardBlocks, boardWith, loginTask } from '~/stories/board.stories.mocks'
import { failure } from '~/stories/pipelineStep.stories.mocks'
import { seedBoard, seedViewer, withSeed } from '~/stories/withStores'
import { useAgentRunsStore, type AgentRunSummary } from '~/stores/agentRuns'
import { useAuthStore } from '~/stores/auth'
import AgentFailureCard from './AgentFailureCard.vue'

// The failure banner on a card, the inspector and the task panel, for a failed task run or a
// failed bootstrap. The title follows the failure kind, and an environment failure adds a button
// to where environments are set up. The messages and hints are the backend's own wording for each
// kind (`EXECUTION_FAILURE_HINTS` in `RunStateMachine.ts`, `classifyDispatchFailure` in
// `job.logic.ts`, `FAILURE_HINTS` in `BootstrapService.ts`). The provider errors in the details,
// and the provider message in the environment story, are made up. Retry calls the unified retry,
// which no story answers.
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

/**
 * An evicted container: the title, the message, the hint, the detail behind a disclosure, and
 * Retry run.
 */
export const Default: Story = {}

/**
 * The compact variant: the message is cut to two lines, Retry is short, and there is no detail.
 * The hint is not cut, so a long hint still fills the card.
 */
export const Compact: Story = {
  args: { variant: 'compact' },
  parameters: { width: 'narrow' },
}

/** The container never started: titled as such, with the runner's answer in the detail. */
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

/** The environment provider failed: a second button opens the environment setup. */
export const EnvironmentFailure: Story = {
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
 * Local mode, and the service deploys to Kubernetes with no deploy runner wired: the env var hint
 * shows under the backend's message.
 */
export const DeployRunnerUnwiredLocal: Story = {
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

/** No repository linked: the run was refused before it started, under the conflict title. */
export const GithubNotConnected: Story = {
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
 * A new-repository bootstrap refused before it started: Retry bootstrap, and Model activity,
 * because a bootstrap has no steps to reach its model calls from.
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
