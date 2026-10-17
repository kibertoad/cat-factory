import type { Meta, StoryObj } from '@storybook/vue3'
import { authInitiative } from '~/stories/board.stories.mocks'
import {
  awaitingAnswersSnapshot,
  initiative,
  initiativeItems,
  initiativeSnapshot,
  interviewingSnapshot,
  planGateSnapshot,
  planningRun,
} from '~/stories/initiative.stories.mocks'
import { decision, step } from '~/stories/pipelineStep.stories.mocks'
import { withSnapshot } from '~/stories/withStores'
import InitiativeCard from './InitiativeCard.vue'

// The board card for an initiative, in the band above a service's lanes: its title and status,
// the plan's progress once there is one, and the one button for where planning is. A run parked
// on a person pulses the card and offers the window that resolves the park. The initiative is the
// shared one (`initiative.stories.mocks.ts`). Every button opens a window or sends a request no
// story answers.
const meta = {
  title: 'Board/Components/InitiativeCard',
  component: InitiativeCard,
  args: { blockId: authInitiative.id },
} satisfies Meta<typeof InitiativeCard>
export default meta

type Story = StoryObj<typeof meta>

/** Not planned yet: Run planning and the tracker. */
export const Default: Story = {
  decorators: [withSnapshot(initiativeSnapshot(initiative()))],
}

/** The loop runs the committed plan: three of seven items settled. */
export const WithProgress: Story = {
  decorators: [
    withSnapshot(initiativeSnapshot(initiative({ status: 'executing', items: initiativeItems }))),
  ],
}

/** The interviewer parked the run on its questions: the card pulses, and Answer planning questions. */
export const AwaitingAnswers: Story = {
  decorators: [withSnapshot(awaitingAnswersSnapshot())],
}

/** The interviewer is writing its next round: Planning in progress, which opens the window. */
export const PlanningInProgress: Story = {
  decorators: [withSnapshot(interviewingSnapshot())],
}

/** The planner's draft waits at its gate: the card pulses, and Review plan. */
export const PlanApproval: Story = {
  decorators: [withSnapshot(planGateSnapshot())],
}

/** The analyst asked a question with options: the card pulses, and the button to answer it. */
export const Decision: Story = {
  decorators: [
    withSnapshot(
      initiativeSnapshot(initiative(), {
        run: planningRun('blocked', 0, [
          step({
            agentKind: 'initiative-analyst',
            state: 'waiting_decision',
            progress: 0.6,
            decision: decision({
              id: 'dec_identity_scope',
              question: 'Does the plan cover the partner API sign-in too?',
              options: ['Yes, in the same phase', 'Yes, as a later phase', 'No, out of scope'],
            }),
          }),
          step({ agentKind: 'initiative-interviewer', state: 'pending', progress: 0 }),
          step({ agentKind: 'initiative-planner', state: 'pending', progress: 0 }),
          step({ agentKind: 'initiative-committer', state: 'pending', progress: 0 }),
        ]),
      }),
    ),
  ],
}

/** The board has no planning pipeline, so Run planning is disabled. */
export const NoPlanningPipeline: Story = {
  decorators: [withSnapshot(initiativeSnapshot(initiative(), { pipelines: [] }))],
}
