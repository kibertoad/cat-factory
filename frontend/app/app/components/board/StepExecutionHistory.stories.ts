import type { Meta, StoryObj } from '@storybook/vue3'
import { failure, priorOutput } from '~/stories/pipelineStep.stories.mocks'
import StepExecutionHistory from './StepExecutionHistory.vue'

// The step-detail overlay's history of a step's earlier attempts, newest first: failed attempts,
// and successful ones whose output a restart discarded. Showing the successes is what stops the
// history reading as a step that never produced anything.
const meta = {
  title: 'Pipeline/Components/StepExecutionHistory',
  component: StepExecutionHistory,
  parameters: { width: 'panel' },
} satisfies Meta<typeof StepExecutionHistory>
export default meta

type Story = StoryObj<typeof meta>

/** The mixed case: an attempt produced something, a later one died. */
export const Default: Story = {
  args: {
    failures: [failure()],
    outputs: [priorOutput()],
  },
}

/** Failures only, which is what a step that never got anywhere looks like. */
export const FailuresOnly: Story = {
  args: {
    failures: [
      failure(),
      failure({
        kind: 'timeout',
        message: 'The step ran past its budget.',
        detail: null,
        hint: 'Raise JOB_MAX_DURATION_MS or split the task.',
        occurredAt: Date.UTC(2026, 9, 11, 8, 55, 0),
      }),
    ],
    outputs: [],
  },
}

/** Discarded output and no failure: the attempt succeeded and a restart replaced it. */
export const OutputsOnly: Story = {
  args: { failures: [], outputs: [priorOutput()] },
}

/** Clipped output, which says so under the box. */
export const TruncatedOutput: Story = {
  args: {
    failures: [],
    outputs: [
      priorOutput({
        truncated: true,
        output: 'Rewrote the session store. '.repeat(40),
      }),
    ],
  },
}
