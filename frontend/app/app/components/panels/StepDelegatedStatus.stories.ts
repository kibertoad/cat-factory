import type { Meta, StoryObj } from '@storybook/vue3'
import type { RunDelegation } from '@cat-factory/contracts'
import { step } from '~/stories/pipelineStep.stories.mocks'
import StepDelegatedStatus from './StepDelegatedStatus.vue'

// A step the platform handed to an external executor that a deployment registered: its status,
// the link to that system's own logs, the branch it landed on, and earlier attempts. The platform
// sees none of the executor's model calls, so the card says the spend is not reported. The
// executor here is invented; the platform ships none.
const executor = {
  label: 'Acme build farm',
  description: 'Runs the coder on the build farm with the house toolchain.',
  telemetry: 'not-reported' as const,
}

const delegated = (overrides: Partial<RunDelegation> = {}): RunDelegation => ({
  executor: 'acme-build-farm',
  status: 'running',
  correlationKey: 'exec_login:1',
  externalId: 'bf-20931',
  url: 'https://builds.acme.dev/runs/bf-20931',
  phase: 'compiling',
  attempts: [
    { startedAt: Date.UTC(2026, 9, 11, 9, 40), url: 'https://builds.acme.dev/runs/bf-20931' },
  ],
  ...overrides,
})

const meta = {
  title: 'Pipeline/Components/StepDelegatedStatus',
  component: StepDelegatedStatus,
  parameters: { width: 'panel' },
  args: { step: step({ delegated: delegated() }), executor },
} satisfies Meta<typeof StepDelegatedStatus>
export default meta

type Story = StoryObj<typeof meta>

/** Running on the build farm, with its phase, the run link, and the spend not reported. */
export const Default: Story = {}

/** Done, and pushed to a branch rather than opening a pull request. */
export const DoneWithBranch: Story = {
  args: {
    step: step({
      state: 'done',
      progress: 1,
      delegated: delegated({ status: 'done', phase: null, branch: 'cf/task-login-endpoint' }),
    }),
  },
}

/** Failed on its second try, with the executor's note and the first attempt listed. */
export const FailedWithAttempts: Story = {
  args: {
    step: step({
      delegated: delegated({
        status: 'failed',
        externalId: 'bf-20977',
        url: 'https://builds.acme.dev/runs/bf-20977',
        note: 'The build farm reported the job as lost after a node restart.',
        attempts: [
          {
            startedAt: Date.UTC(2026, 9, 11, 9, 40),
            url: 'https://builds.acme.dev/runs/bf-20931',
            outcome: 'Tests failed: 3 of 412',
          },
          {
            startedAt: Date.UTC(2026, 9, 11, 10, 5),
            url: 'https://builds.acme.dev/runs/bf-20977',
            outcome: 'Lost',
          },
        ],
      }),
    }),
  },
}

/** This build no longer registers the executor, so the card names its stored id. */
export const UnregisteredExecutor: Story = { args: { executor: undefined } }

/** A status this build does not know: named as unrecognised, with the stored value. */
export const UnrecognisedStatus: Story = {
  args: {
    step: step({ delegated: { ...delegated(), status: 'paused' as RunDelegation['status'] } }),
  },
}

/** A run link that is not http or https: shown as text, not followed. */
export const UnsafeRunUrl: Story = {
  args: { step: step({ delegated: delegated({ url: 'javascript:alert(1)' }) }) },
}
