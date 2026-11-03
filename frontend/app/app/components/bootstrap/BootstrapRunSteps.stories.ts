import type { Meta, StoryObj } from '@storybook/vue3'
import type { BootstrapJob } from '@cat-factory/contracts'
import { applyingJob, awaitingReviewJob, failedApplyJob } from '~/stories/bootstrap.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useAgentRunsStore } from '~/stores/agentRuns'
import BootstrapRunSteps from './BootstrapRunSteps.vue'

// The steps of a monorepo bootstrap, with the one the run reached marked. It reads the run from
// the agent runs store by id, so each story puts one run there. A new-repo bootstrap has one step
// and renders nothing, so every story here is a monorepo run.
const meta = {
  title: 'Board/Components/BootstrapRunSteps',
  component: BootstrapRunSteps,
  parameters: { width: 'narrow' },
  args: { runId: 'boot_billing' },
} satisfies Meta<typeof BootstrapRunSteps>
export default meta

type Story = StoryObj<typeof meta>

function withRun(job: BootstrapJob) {
  return withSeed(() => {
    useAgentRunsStore().bootstrapJobs = [job]
  })
}

/** Writing the service: the survey and the review are done. */
export const Default: Story = {
  decorators: [withRun(applyingJob())],
}

/** The survey is done and the run waits for the adoption decisions. */
export const AwaitingReview: Story = {
  decorators: [withRun(awaitingReviewJob())],
}

/** The write step failed; the steps before it stay done. */
export const Failed: Story = {
  decorators: [withRun(failedApplyJob())],
}
