import type { Meta, StoryObj } from '@storybook/vue3'
import { authInitiative } from '~/stories/board.stories.mocks'
import {
  awaitingAnswersSnapshot,
  initiative,
  initiativeItems as items,
  initiativeSnapshot,
  interviewingSnapshot,
  planGateSnapshot,
} from '~/stories/initiative.stories.mocks'
import { withSnapshot } from '~/stories/withStores'
import InitiativeInspector from './InitiativeInspector.vue'

// The inspector body for an initiative: its status, its goal, and the controls for where it is.
// Run planning starts the planning pipeline, and spins while a run owns the block. While the run
// waits on a person the inspector offers the way to answer it: the interview's questions, or the
// drafted plan. Once the plan is committed the loop runs the tasks, which can be paused, resumed
// or cancelled. The initiative and its pipeline are the shared ones (`initiative.stories.mocks.ts`).
// Every button opens a window or sends a request no story answers.
const meta = {
  title: 'Inspector/Components/InitiativeInspector',
  component: InitiativeInspector,
  parameters: { width: 'panel' },
  args: { block: authInitiative },
} satisfies Meta<typeof InitiativeInspector>
export default meta

type Story = StoryObj<typeof meta>

function withInitiative(...args: Parameters<typeof initiativeSnapshot>) {
  return withSnapshot(initiativeSnapshot(...args))
}

/** Not planned yet: the goal, Run planning and the tracker. */
export const Default: Story = {
  decorators: [withInitiative(initiative())],
}

/**
 * The interviewer parked the run on its questions: Answer planning questions comes first, and
 * Run planning spins, because the run still owns the block. The park carries no proposal, so the
 * inspector does not offer it as a plan to review.
 */
export const AwaitingAnswers: Story = {
  decorators: [withSnapshot(awaitingAnswersSnapshot())],
}

/**
 * The interviewer is writing its next round: Planning in progress, which still opens the
 * planning window, beside the spinning Run planning.
 */
export const PlanningInProgress: Story = {
  decorators: [withSnapshot(interviewingSnapshot())],
}

/** The planner's draft waits at its gate: Review plan, in the warning colour. */
export const PlanAwaitingApproval: Story = {
  decorators: [withSnapshot(planGateSnapshot())],
}

/** The loop runs the plan: the item count, Pause and Cancel initiative. */
export const Executing: Story = {
  decorators: [withInitiative(initiative({ status: 'executing', items }))],
}

/** Paused: Resume in place of Pause. */
export const Paused: Story = {
  decorators: [withInitiative(initiative({ status: 'paused', items }))],
}

/** The board has no planning pipeline, so Run planning is disabled. */
export const NoPlanningPipeline: Story = {
  decorators: [withInitiative(initiative(), { pipelines: [] })],
}
