import type { Meta, StoryObj } from '@storybook/vue3'
import { getBugFishingContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import type { BugFishingFinding, BugFishingPhase, BugFishingStepState } from '~/types/execution'
import { apiFailure, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { block } from '~/stories/block.stories.mocks'
import { boardWith } from '~/stories/board.stories.mocks'
import {
  bugFishingPipeline,
  bugfixPipeline,
  standardBuild,
} from '~/stories/pipelines.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, seedViewer, withSeed } from '~/stories/withStores'
import BugFishingWindow from './BugFishingWindow.vue'

// A bug-fishing expedition over Auth Service: one read-only pass per angle, each with its own
// findings. A person marks a finding to fix (a bug task is made and its run starts) or dismisses
// it, and can do so while later angles still fish. The window reads the expedition off the run's
// `bug-fisher` step and asks for it again when it opens, so each story seeds the run and answers
// that read with the same state. The task, the findings and the paths are made up. Every button
// sends a request no story answers.

const fishTask = block({
  id: 'task_fish_auth',
  title: 'Fish Auth Service for bugs',
  parentId: 'svc_auth',
  status: 'in_progress',
  progress: 0.5,
  taskType: 'bug-fishing',
  executionId: 'exec_fish_auth',
})

const settled = Date.UTC(2026, 9, 14, 11, 0)

function phase(
  id: string,
  title: string,
  goal: string,
  overrides: Partial<BugFishingPhase> = {},
): BugFishingPhase {
  return { id, title, goal, status: 'completed', settledAt: settled, ...overrides }
}

const controlFlow = phase(
  'control-flow',
  'Logic & control flow',
  'Find branches that do the wrong thing, or that are missing entirely.',
  { summary: 'Read the sign-in and refresh handlers and the session middleware.' },
)
const errorHandling = phase(
  'error-handling',
  'Failure handling',
  'Find failures that are swallowed, mis-attributed, or left half-applied.',
  { summary: 'Read every catch in the session store and the token service.' },
)
const concurrency = phase(
  'concurrency',
  'Concurrency, ordering & idempotency',
  'Find what breaks when two callers race, or when the same work arrives twice.',
  { summary: 'Read the refresh rotation and the lockout counter.' },
)
const footguns = phase(
  'footguns',
  'Footguns',
  'Find code that is correct today and will be broken by the next honest change.',
  { summary: 'Nothing worth a task: the session API is hard to call incorrectly.' },
)

function finding(
  overrides: Partial<BugFishingFinding> & Pick<BugFishingFinding, 'id' | 'phaseId' | 'title'>,
): BugFishingFinding {
  return {
    path: 'src/sessions/store.ts',
    severity: 'medium',
    kind: 'bug',
    confidence: 'medium',
    detail: '',
    dismissed: false,
    ...overrides,
  }
}

const refreshRace = finding({
  id: 'bf_refresh_race',
  phaseId: 'concurrency',
  path: 'src/sessions/refresh.ts',
  line: 42,
  severity: 'critical',
  confidence: 'high',
  title: 'Two refreshes with one token both succeed',
  detail:
    '`rotateRefresh` reads the token, checks it is unused, and then marks it used in a second ' +
    'query. Two requests in that window both pass the check.',
  failureScenario:
    'A client retries a refresh after a timeout. Both requests get a new token, and the reuse ' +
    'detection never fires.',
  evidence: '`refresh.ts:42` reads with `findToken`, and `refresh.ts:57` writes with `markUsed`.',
  suggestedFix: 'Mark the token used with one conditional update, and refuse when no row changed.',
})

const swallowedRevoke = finding({
  id: 'bf_swallowed_revoke',
  phaseId: 'error-handling',
  line: 118,
  severity: 'high',
  title: 'A failed revoke reports success',
  detail: 'The catch around `revokeFamily` logs the error and returns `{ ok: true }`.',
  suggestedFix: 'Let the error reach the handler, so the client sees a 500 and retries.',
})

const emptyEmail = finding({
  id: 'bf_empty_email',
  phaseId: 'control-flow',
  path: 'src/auth/signIn.ts',
  line: 23,
  severity: 'medium',
  kind: 'edge-case',
  confidence: 'medium',
  title: 'An email of only spaces reaches the user lookup',
  detail: 'The form trims the email after the empty check, so `"   "` passes it.',
})

const lockoutReset = finding({
  id: 'bf_lockout_reset',
  phaseId: 'control-flow',
  path: 'src/auth/lockout.ts',
  severity: 'low',
  kind: 'logic-gap',
  confidence: 'low',
  title: 'A password reset does not clear the lockout counter',
  detail: 'A user who resets their password after a lockout can sign in once and is locked again.',
})

const catchFindings = [refreshRace, swallowedRevoke, emptyEmail, lockoutReset]

function expedition(overrides: Partial<BugFishingStepState> = {}): BugFishingStepState {
  return {
    status: 'awaiting_triage',
    phases: [controlFlow, errorHandling, concurrency, footguns],
    currentPhaseIndex: 3,
    findings: catchFindings,
    defaultFixPipelineId: bugfixPipeline.id,
    ...overrides,
  }
}

/** The expedition's run, with `state` on its one step, opened in the window. */
function opened(state: BugFishingStepState, seed: () => void = () => {}) {
  const run = execution({
    id: 'exec_fish_auth',
    blockId: fishTask.id,
    pipelineId: bugFishingPipeline.id,
    pipelineName: bugFishingPipeline.name,
    status: state.status === 'awaiting_triage' ? 'blocked' : 'running',
    currentStep: 0,
    steps: [
      step({
        agentKind: 'bug-fisher',
        state: state.status === 'awaiting_triage' ? 'waiting_decision' : 'working',
        progress: 0.5,
        bugFishing: state,
      }),
    ],
  })
  return withSeed(() => {
    seedSnapshot(
      snapshot({
        blocks: boardWith(fishTask),
        pipelines: [standardBuild, bugfixPipeline, bugFishingPipeline],
        executions: [run],
      }),
    )
    seedResultView({ view: 'bug-fishing', blockId: fishTask.id, instanceId: run.id, stepIndex: 0 })
    seed()
  })
}

const read = { pathPrefix: storyWorkspacePrefix, pathParams: { executionId: 'exec_fish_auth' } }

/** The read the window makes when it opens, answered with `state`. */
function stateRead(state: BugFishingStepState): HttpHandler {
  return apiResponse(getBugFishingContract, { ...read, body: state })
}

/** The window over `state`, with its read answered by the same state. */
function story(state: BugFishingStepState, seed?: () => void): Story {
  return { decorators: [opened(state, seed)], parameters: { api: [stateRead(state)] } }
}

const meta = {
  title: 'Pipeline/Pages/BugFishingWindow',
  component: BugFishingWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof BugFishingWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Every angle has landed and the expedition waits for triage: four findings, most severe first,
 * the pipeline the fixes will run on, and Finish triage.
 */
export const Default: Story = story(expedition())

/**
 * Two angles have landed, one is fishing and one is queued: the banner over the findings that
 * are ready now, and no Finish.
 */
export const Fishing: Story = story(
  expedition({
    status: 'fishing',
    currentPhaseIndex: 2,
    phases: [
      controlFlow,
      errorHandling,
      { ...concurrency, status: 'fishing', summary: null, settledAt: null },
      { ...footguns, status: 'pending', summary: null, settledAt: null },
    ],
    findings: [swallowedRevoke, emptyEmail, lockoutReset],
  }),
)

/** Every angle landed and caught nothing. */
export const Empty: Story = story(expedition({ findings: [] }))

/** The read when the window opens failed: the error line over the findings from the board. */
export const LoadError: Story = {
  decorators: [opened(expedition())],
  parameters: { api: [apiFailure(getBugFishingContract, read)] },
}

/**
 * The decided findings shown: one fixed, one with its task being made, one whose task could not
 * be made (open again), one dismissed, and one still open.
 */
export const Triaged: Story = {
  ...story(
    expedition({
      findings: [
        {
          ...refreshRace,
          spawn: {
            status: 'spawned',
            taskId: 'task_fix_refresh_race',
            pipelineId: bugfixPipeline.id,
            requestedAt: settled,
          },
        },
        {
          ...swallowedRevoke,
          spawn: {
            status: 'pending',
            taskId: 'task_fix_revoke',
            pipelineId: bugfixPipeline.id,
            // A claim younger than its five minutes, so the window reads it as in flight.
            requestedAt: Date.now(),
          },
        },
        {
          ...emptyEmail,
          spawn: {
            status: 'failed',
            taskId: 'task_fix_empty_email',
            pipelineId: bugfixPipeline.id,
            requestedAt: settled,
            failureReason: 'The board has no repository linked to Auth Service.',
          },
        },
        { ...lockoutReset, dismissed: true },
        finding({
          id: 'bf_cookie_path',
          phaseId: 'footguns',
          path: 'src/sessions/cookie.ts',
          severity: 'low',
          kind: 'footgun',
          title: 'The cookie path is set in two places',
          detail: 'The middleware and the sign-in handler each set `Path=/`.',
        }),
      ],
    }),
  ),
  play: async () => {
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Show decided' }))
  },
}

const sessionsTerritory = { territoryId: 'mod_sessions', territoryLabel: 'Sessions' }
const tokensTerritory = { territoryId: 'src_tokens', territoryLabel: 'src/tokens' }

/**
 * A codebase too large to fish whole: the angles grouped by territory with the share each pass
 * read, and the warning that the tree came back cut and that the budget left two passes unfished.
 */
export const CoverageGaps: Story = story(
  expedition({
    phases: [
      {
        ...controlFlow,
        ...sessionsTerritory,
        coverage: { filesRead: 38, manifestFiles: 42, offManifest: 0, source: 'self-reported' },
      },
      {
        ...concurrency,
        ...sessionsTerritory,
        coverage: { filesRead: 30, manifestFiles: 42, offManifest: 1, source: 'self-reported' },
      },
      {
        ...controlFlow,
        ...tokensTerritory,
        summary: 'Read the token signer only.',
        coverage: { filesRead: 3, manifestFiles: 27, offManifest: 0, source: 'self-reported' },
      },
    ],
    findings: [
      { ...refreshRace, ...sessionsTerritory },
      { ...emptyEmail, ...sessionsTerritory },
    ],
    plan: {
      passBudget: 3,
      plannedCells: 5,
      treeTruncated: true,
      unfished: [
        {
          territoryId: 'src_tokens',
          territoryLabel: 'src/tokens',
          phaseId: 'concurrency',
          phaseTitle: 'Concurrency, ordering & idempotency',
        },
        {
          territoryId: 'mod_sessions',
          territoryLabel: 'Sessions',
          phaseId: 'footguns',
          phaseTitle: 'Footguns',
        },
      ],
    },
  }),
)

/** The repository could not be surveyed, so the expedition fished the codebase whole. */
export const NotSurveyed: Story = story(
  expedition({
    plan: {
      passBudget: 24,
      plannedCells: 4,
      unfished: [],
      treeTruncated: false,
      surveyUnavailableReason: 'No repository is linked to this run.',
    },
  }),
)

/** The concurrency angle failed, opened in the rail: its goal and why it did not complete. */
export const PhaseFailed: Story = {
  ...story(
    expedition({
      phases: [
        controlFlow,
        errorHandling,
        {
          ...concurrency,
          status: 'failed',
          summary: null,
          failureReason: 'The container was lost after 20 minutes.',
        },
        footguns,
      ],
      findings: [swallowedRevoke, emptyEmail, lockoutReset],
    }),
  ),
  play: async () => {
    await userEvent.click(await screen.findByTestId('bug-fishing-phase-concurrency'))
  },
}

/** A board viewer: the findings with no pipeline, no Fix or Dismiss, and Finish off. */
export const ReadOnly: Story = story(expedition(), seedViewer)
