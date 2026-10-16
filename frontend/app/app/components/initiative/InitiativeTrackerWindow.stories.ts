import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getInitiativeByBlockContract,
  type Initiative,
  type WorkspaceSnapshot,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authInitiative, boardWithInitiative } from '~/stories/board.stories.mocks'
import {
  initiativePhases,
  initiativeSnapshot,
  planGateSnapshot,
  trackedInitiative,
  trackedItems,
} from '~/stories/initiative.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import InitiativeTrackerWindow from './InitiativeTrackerWindow.vue'

// The tracker of an initiative: the goal, the constraints and the analysis, then each phase with
// its items, their status and their pull requests, the execution policy, and the decisions,
// deviations, follow-ups and caveats. While the initiative runs, a blocked item can be retried, a
// pending one skipped, the policy edited and an open follow-up promoted into a phase or dismissed.
// The window also holds the planner's approval gate: a plan rendered as a document takes the whole
// window for review, and a plan with no document gets a notice above the sections. The window
// opens from the card or the inspector (`ui.openInitiativeTracker`) and reads the initiative again
// when it opens, so each story answers that read with the entity its snapshot holds. The
// initiative is the shared one (`initiative.stories.mocks.ts`). Every button sends a request no
// story answers.

/** The window opened on the initiative of `board`, whose read answers the same entity. */
function tracker(board: WorkspaceSnapshot, entity: Initiative | null = board.initiatives![0]!) {
  return {
    decorators: [
      withSeed(() => {
        seedSnapshot(board)
        useUiStore().openInitiativeTracker(authInitiative.id)
      }),
    ],
    parameters: {
      api: [
        apiResponse(getInitiativeByBlockContract, {
          pathPrefix: storyWorkspacePrefix,
          pathParams: { blockId: authInitiative.id },
          body: entity,
        }),
      ],
    },
  }
}

const meta = {
  title: 'Board/Pages/InitiativeTrackerWindow',
  component: InitiativeTrackerWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof InitiativeTrackerWindow>
export default meta

type Story = StoryObj<typeof meta>

const executing = initiativeSnapshot(trackedInitiative())

/**
 * The loop runs the plan: three of seven items settled, a pull request open, one item blocked
 * with Retry and Skip, the audit phase's checkpoint ahead, and every log with an entry.
 */
export const Default: Story = tracker(executing)

/** The initiative is not on the board yet and its read finds nothing: the empty state. */
export const Empty: Story = tracker(
  snapshot({ blocks: boardWithInitiative, initiatives: [] }),
  null,
)

/**
 * The planner's plan waits at its gate as a rendered document: the review takes the window, with
 * the outline, the run details and the decision rail.
 */
export const PlanReview: Story = tracker(planGateSnapshot({ rendered: true }))

const ingested = planGateSnapshot()

/**
 * The plan waits at its gate with no document: the notice holds the decision, and the phases
 * below, all pending, are the plan.
 */
export const PlanNotice: Story = tracker({
  ...ingested,
  initiatives: [
    trackedInitiative({
      status: 'awaiting_approval',
      items: trackedItems.map((i) => ({ ...i, status: 'pending', pr: undefined, note: undefined })),
      decisions: [],
      deviations: [],
      followUps: [],
    }),
  ],
})

/**
 * The session phase ended at its checkpoint and the loop paused: the banner with Resume and
 * Cancel, and the phase's badge says it awaits review.
 */
export const PausedAtCheckpoint: Story = tracker(
  initiativeSnapshot(
    trackedInitiative({
      status: 'paused',
      phases: initiativePhases.map((p) => ({ ...p, checkpoint: p.id === 'ph_sessions' })),
      items: trackedItems.map((i) =>
        i.phaseId === 'ph_sessions' && i.status !== 'skipped'
          ? { ...i, status: 'done', note: undefined }
          : i,
      ),
    }),
  ),
)

/** Edit opens the policy form: the number of tasks at once and the default pipeline. */
export const EditingPolicy: Story = {
  ...tracker(executing),
  play: async () => {
    await userEvent.click(await screen.findByTestId('initiative-policy-edit'))
    await screen.findByTestId('initiative-policy-max-concurrent')
  },
}

/**
 * Promote opens the form on the open follow-up: the phase, which starts on the phase of the item
 * it came from, and its title.
 */
export const PromotingFollowUp: Story = {
  ...tracker(executing),
  play: async () => {
    await userEvent.click(await screen.findByTestId('initiative-followup-promote'))
    await screen.findByTestId('initiative-promote-title')
  },
}
