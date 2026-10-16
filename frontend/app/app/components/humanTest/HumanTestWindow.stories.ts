import type { Meta, StoryObj } from '@storybook/vue3'
import type { HumanTestRound, HumanTestStepState } from '@cat-factory/contracts'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import HumanTestWindow from './HumanTestWindow.vue'

// A person tests the login task in a preview environment before the run goes on. The window
// shows the environment and its link, the actions on it (recreate, destroy, pull the latest main
// in), a box for what went wrong, which a fixer then works on, and the rounds so far; Confirm
// passes the gate. The state rides on the run's human-test step, so each story seeds its own run. The
// degraded reason is the backend's own wording (`HumanTestController`); the findings are made up.
const ENV_URL = 'https://login-pr-212.preview.acme.dev'

function gate(overrides: Partial<HumanTestStepState> = {}): HumanTestStepState {
  return {
    phase: 'awaiting_human',
    environment: {
      id: 'env_212',
      url: ENV_URL,
      status: 'ready',
      expiresAt: Date.UTC(2026, 9, 16, 18, 0),
    },
    attempts: 0,
    maxAttempts: 3,
    rounds: [],
    ...overrides,
  }
}

const fixRound: HumanTestRound = {
  kind: 'fix',
  findings:
    'Log out everywhere signs out this browser only. The phone stays signed in until it ' +
    'refreshes.',
  helperKind: 'fixer',
  jobId: 'job_fix_1',
  outcome: 'completed',
  at: Date.UTC(2026, 9, 13, 9, 30),
}

function opened(state: HumanTestStepState | null) {
  const run = execution({
    steps: [
      step({ agentKind: 'coder', state: 'done', progress: 1 }),
      step({ agentKind: 'deployer', state: 'done', progress: 1 }),
      step({
        agentKind: 'human-test',
        state: state?.phase === 'passed' ? 'done' : 'working',
        progress: state?.phase === 'passed' ? 1 : 0.5,
        ...(state ? { humanTest: state } : {}),
      }),
    ],
    currentStep: 2,
  })
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [run] }))
    seedResultView({ view: 'human-test', blockId: run.blockId, instanceId: run.id, stepIndex: 2 })
  })
}

const meta = {
  title: 'Review/Pages/HumanTestWindow',
  component: HumanTestWindow,
} satisfies Meta<typeof HumanTestWindow>
export default meta

type Story = StoryObj<typeof meta>

/** The preview is up and waits for a person: its link, the environment actions, and Confirm. */
export const Default: Story = {
  decorators: [opened(gate())],
}

/** The step has not started its gate yet. */
export const NotStarted: Story = {
  decorators: [opened(null)],
}

/** The environment is being stood up: no link yet, and only Destroy is on. */
export const Provisioning: Story = {
  decorators: [
    opened(
      gate({
        phase: 'provisioning',
        environment: { id: 'env_212', url: null, status: 'provisioning', expiresAt: null },
      }),
    ),
  ],
}

/**
 * No environment provider is configured: the backend's reason, and the person tests the pull
 * request branch and confirms here.
 */
export const NoEnvironment: Story = {
  decorators: [
    opened(
      gate({
        environment: null,
        degradedReason:
          'No ephemeral-environment provider is configured; test against the PR branch and ' +
          'confirm here.',
      }),
    ),
  ],
}

/** The person asked for a fix: the fixer works on the findings, and the round is open. */
export const Fixing: Story = {
  decorators: [
    opened(gate({ phase: 'fixing', attempts: 1, rounds: [{ ...fixRound, outcome: null }] })),
  ],
}

/**
 * Confirmed after one fix: the environment is torn down, the round is complete, and nothing is
 * left to do.
 */
export const Passed: Story = {
  decorators: [
    opened(
      gate({
        phase: 'passed',
        attempts: 1,
        rounds: [fixRound],
        environment: { id: 'env_212', url: ENV_URL, status: 'torn_down', expiresAt: null },
      }),
    ),
  ],
}
