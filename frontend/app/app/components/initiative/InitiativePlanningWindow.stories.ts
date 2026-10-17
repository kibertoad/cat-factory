import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getInitiativeByBlockContract,
  type Initiative,
  type WorkspaceSnapshot,
} from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authInitiative, boardWithInitiative } from '~/stories/board.stories.mocks'
import {
  awaitingAnswersSnapshot,
  initiative,
  initiativeSnapshot,
  interviewingSnapshot,
  interviewQuestions,
  planningRun,
} from '~/stories/initiative.stories.mocks'
import { failure, step } from '~/stories/pipelineStep.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import InitiativePlanningWindow from './InitiativePlanningWindow.vue'

// The planning interview of an initiative: the interviewer's questions, open ones first, each
// with an answer box, Not relevant and a suggested answer on request. Submit answers sends them
// and the interviewer runs again; Plan now skips the rest. While the run does something else the
// window says what instead of the questions, and Discard run is there as long as a run owns the
// block. The run details are beside the questions from the lg width. The window opens from the
// card or the inspector (`ui.openInitiativePlanning`) and reads the initiative again when it
// opens, so each story answers that read with the entity its snapshot holds. The initiative,
// its run and its questions are the shared ones (`initiative.stories.mocks.ts`). Every button
// sends a request no story answers.

/** The window opened on the initiative of `board`. */
function opened(board: WorkspaceSnapshot) {
  return withSeed(() => {
    seedSnapshot(board)
    useUiStore().openInitiativePlanning(authInitiative.id)
  })
}

/** The initiative's read, answering `entity`. */
function readAnswers(entity: Initiative | null) {
  return [
    apiResponse(getInitiativeByBlockContract, {
      pathPrefix: storyWorkspacePrefix,
      pathParams: { blockId: authInitiative.id },
      body: entity,
    }),
  ]
}

/** `board` with its initiative's questions set to the shared interview. */
function withQuestions(board: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    ...board,
    initiatives: board.initiatives?.map((i) => ({ ...i, qa: interviewQuestions })),
  }
}

const awaiting = withQuestions(awaitingAnswersSnapshot())

const meta = {
  title: 'Board/Pages/InitiativePlanningWindow',
  component: InitiativePlanningWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof InitiativePlanningWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The run waits on round one: two open questions first, the first with its suggested answer,
 * then the answered one and the one set aside. Two are unanswered, so Submit answers is off.
 */
export const Default: Story = {
  decorators: [opened(awaiting)],
  parameters: { api: readAnswers(awaiting.initiatives![0]!) },
}

/** The initiative is not on the board yet and its read finds nothing: the empty state. */
export const Empty: Story = {
  decorators: [opened(snapshot({ blocks: boardWithInitiative, initiatives: [] }))],
  parameters: { api: readAnswers(null) },
}

const preparing = initiativeSnapshot(initiative(), {
  run: planningRun('running', 0, [
    step({ agentKind: 'initiative-analyst', state: 'working', progress: 0.4 }),
    step({ agentKind: 'initiative-interviewer', state: 'pending', progress: 0 }),
    step({ agentKind: 'initiative-planner', state: 'pending', progress: 0 }),
    step({ agentKind: 'initiative-committer', state: 'pending', progress: 0 }),
  ]),
})

/** The analyst still reads the codebase, ahead of the interview: nothing is asked yet. */
export const Preparing: Story = {
  decorators: [opened(preparing)],
  parameters: { api: readAnswers(preparing.initiatives![0]!) },
}

const working = withQuestions(interviewingSnapshot())

/** The interviewer reads the answers and writes its next round: the notice replaces the list. */
export const Working: Story = {
  decorators: [opened(working)],
  parameters: { api: readAnswers(working.initiatives![0]!) },
}

const failed = initiativeSnapshot(
  initiative({
    qa: interviewQuestions,
    interview: { round: 1, maxRounds: 3, status: 'awaiting' },
  }),
  {
    run: planningRun('failed', 1, [
      step({ agentKind: 'initiative-analyst', state: 'done', progress: 1 }),
      step({ agentKind: 'initiative-interviewer', state: 'working', progress: 0.5 }),
      step({ agentKind: 'initiative-planner', state: 'pending', progress: 0 }),
      step({ agentKind: 'initiative-committer', state: 'pending', progress: 0 }),
    ]),
  },
)
failed.executions![0]!.failure = failure({
  message: 'The interviewer returned no questions and no verdict.',
  stepIndex: 1,
})

/** The run failed before the interview settled: the failed notice, and Discard run alone. */
export const Failed: Story = {
  decorators: [opened(failed)],
  parameters: { api: readAnswers(failed.initiatives![0]!) },
}

const converged = initiativeSnapshot(
  initiative({
    qa: interviewQuestions,
    interview: { round: 2, maxRounds: 3, status: 'done' },
  }),
  {
    run: planningRun('running', 2, [
      step({ agentKind: 'initiative-analyst', state: 'done', progress: 1 }),
      step({ agentKind: 'initiative-interviewer', state: 'done', progress: 1 }),
      step({ agentKind: 'initiative-planner', state: 'working', progress: 0.3 }),
      step({ agentKind: 'initiative-committer', state: 'pending', progress: 0 }),
    ]),
  },
)

/** The interview settled and the planner drafts the plan: the converged line. */
export const Converged: Story = {
  decorators: [opened(converged)],
  parameters: { api: readAnswers(converged.initiatives![0]!) },
}
