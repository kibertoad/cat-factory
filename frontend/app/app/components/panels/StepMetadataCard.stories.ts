import type { Meta, StoryObj } from '@storybook/vue3'
import { stepMetrics } from '~/stories/observability.stories.mocks'
import {
  approval,
  companionVerdicts as verdicts,
  decision,
  step,
} from '~/stories/pipelineStep.stories.mocks'
import { modelOption } from '~/stories/providers.stories.mocks'
import { seedModelCatalog, withSeed } from '~/stories/withStores'
import StepMetadataCard from './StepMetadataCard.vue'

// The facts block at the top of a step's reader: state, duration, position, start and finish,
// model and run id; then the agent's todo list, the model activity, and whatever stopped or
// graded the step (a question, an approval, a reviewer's rounds). Each story passes the step and
// the reader's derived values as props. The model catalog is seeded so the model has its name.
//
// A working step's clock is relative to now, so it starts six minutes before the story loads.
const KIMI = 'workers-ai:@cf/moonshotai/kimi-k2.7-code'
const started = Date.now() - 6 * 60_000

const coder = step({
  agentKind: 'coder',
  state: 'working',
  progress: 0.5,
  model: KIMI,
  startedAt: started,
  metrics: stepMetrics(),
  subtasks: {
    completed: 2,
    inProgress: 1,
    total: 4,
    items: [
      { label: 'Add a single-flight lock around refresh', status: 'completed' },
      { label: 'Revoke the family on reuse', status: 'completed' },
      { label: 'Cover two refreshes at once', status: 'in_progress' },
      { label: 'Update the session docs', status: 'pending' },
    ],
  },
})

const done = step({
  agentKind: 'architect',
  state: 'done',
  progress: 1,
  model: KIMI,
  startedAt: Date.UTC(2026, 9, 11, 9, 2),
  finishedAt: Date.UTC(2026, 9, 11, 9, 9, 30),
})

const meta = {
  title: 'Pipeline/Components/StepMetadataCard',
  component: StepMetadataCard,
  args: {
    step: coder,
    runFailed: false,
    runActive: true,
    durationLabel: '6m 0s',
    isRunning: true,
    stepNumber: 2,
    totalSteps: 3,
    instanceId: 'exec_login',
    companionVerdicts: [],
    latestVerdict: null,
  },
  parameters: { width: 'prose' },
  decorators: [withSeed(() => seedModelCatalog([modelOption()]))],
} satisfies Meta<typeof StepMetadataCard>
export default meta

type Story = StoryObj<typeof meta>

/** The coder at work: two of four todo items done, one in progress, and the model activity. */
export const Default: Story = {}

/** The architect's finished step: start, finish and its duration. */
export const Done: Story = {
  args: { step: done, durationLabel: '7m 30s', isRunning: false, stepNumber: 1, runActive: false },
}

/** The run failed while the coder was working: the state reads Failed, and the clock stops. */
export const FailedMidRun: Story = {
  args: { runFailed: true, runActive: false, isRunning: false },
}

/** The architect asked a question that is not answered yet. */
export const WithDecision: Story = {
  args: {
    step: { ...done, state: 'waiting_decision', decision: decision() },
    stepNumber: 1,
    isRunning: false,
    durationLabel: '7m 30s',
  },
}

/** The architect's plan waits for an approval. */
export const WithApproval: Story = {
  args: {
    step: { ...done, state: 'waiting_decision', approval: approval() },
    stepNumber: 1,
    isRunning: false,
    durationLabel: '7m 30s',
  },
}

/**
 * Two companion rounds. The second rated 82% against a 75% bar and still did not pass, because a
 * blocker is open; the badge says so with the colour, and the arithmetic stays true.
 */
export const WithCompanionVerdicts: Story = {
  args: {
    step: done,
    stepNumber: 1,
    isRunning: false,
    durationLabel: '7m 30s',
    companionVerdicts: verdicts,
    latestVerdict: verdicts[1]!,
  },
}
