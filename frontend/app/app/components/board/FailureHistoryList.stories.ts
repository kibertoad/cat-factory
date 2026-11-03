import type { Meta, StoryObj } from '@storybook/vue3'
import { failure } from '~/stories/pipelineStep.stories.mocks'
import FailureHistoryList from './FailureHistoryList.vue'

// The list inside `AgentFailureHistory`, newest first: it reverses what it is given. Each entry
// shows the time and the cause line for its kind, with the message, the hint and the detail behind
// Details (`FailureListEntry`).
const meta = {
  title: 'Inspector/Components/FailureHistoryList',
  component: FailureHistoryList,
  parameters: { width: 'panel' },
} satisfies Meta<typeof FailureHistoryList>
export default meta

type Story = StoryObj<typeof meta>

/** Newest first: a hint and no detail, a detail and a hint, a detail and no hint. */
export const Default: Story = {
  args: {
    failures: [
      failure({
        kind: 'environment',
        message: 'The ephemeral environment never came up.',
        detail: 'deploy runner is not wired',
        hint: null,
        occurredAt: Date.UTC(2026, 9, 11, 8, 40, 0),
      }),
      failure({ occurredAt: Date.UTC(2026, 9, 11, 9, 2, 0) }),
      failure({
        kind: 'timeout',
        message: 'The step ran past its budget.',
        detail: null,
        hint: 'Raise JOB_MAX_DURATION_MS or split the task.',
        occurredAt: Date.UTC(2026, 9, 11, 9, 32, 0),
      }),
    ],
  },
}

/** A failure with no detail and no hint: Details holds the message only. */
export const Bare: Story = {
  args: {
    failures: [
      failure({
        kind: 'unknown',
        message: 'The run ended without a reason.',
        detail: null,
        hint: null,
      }),
    ],
  },
}
