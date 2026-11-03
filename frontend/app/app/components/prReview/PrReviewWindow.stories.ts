import type { Meta, StoryObj } from '@storybook/vue3'
import { getPrReviewContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import type { PipelineStep, PrReviewFinding, PrReviewStepState } from '~/types/execution'
import { apiFailure, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { prReview, step, subtasks } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import PrReviewWindow from './PrReviewWindow.vue'

// The deep review of the login task's pull request: the reviewer splits the diff into slices,
// reviews each, and lists its findings by slice and severity. A person picks the findings that
// matter, can challenge one, and then has them fixed, posted as comments, or only recorded. The
// window reads the review off the run's `pr-reviewer` step and asks for it again when it opens,
// so each story seeds the run and answers that read with the same state. The slices, findings
// and paths are made up. Every button sends a request no story answers.

const slices = [
  {
    id: 'sl_refresh',
    title: 'Refresh rotation',
    rationale: 'The new rotation and its reuse check, read together.',
    paths: ['src/sessions/refresh.ts', 'src/sessions/store.ts'],
  },
  {
    id: 'sl_api',
    title: 'Refresh endpoint',
    rationale: 'The handler and its error answers.',
    paths: ['src/api/refresh.ts'],
  },
]

function finding(
  overrides: Partial<PrReviewFinding> & Pick<PrReviewFinding, 'id' | 'title'>,
): PrReviewFinding {
  return {
    sliceId: 'sl_refresh',
    path: 'src/sessions/refresh.ts',
    severity: 'medium',
    category: 'correctness',
    detail: '',
    ...overrides,
  }
}

const reuseRace = finding({
  id: 'pf_reuse_race',
  line: 42,
  severity: 'blocker',
  title: 'Two refreshes with one token both succeed',
  detail: 'The check and the write are two queries, so two requests can pass the check.',
  suggestedFix: 'Mark the token used with one conditional update.',
})
const leakedFamily = finding({
  id: 'pf_family_log',
  path: 'src/sessions/store.ts',
  line: 88,
  severity: 'high',
  category: 'security',
  title: 'The session family id is logged with the token',
  detail: 'The log line at revoke carries the raw refresh token.',
})
const status401 = finding({
  id: 'pf_status',
  sliceId: 'sl_api',
  path: 'src/api/refresh.ts',
  line: 17,
  severity: 'low',
  category: 'maintainability',
  title: 'A reused token answers 400, not 401',
  detail: 'Clients treat 400 as their own error and do not sign the user out.',
})
const naming = finding({
  id: 'pf_naming',
  sliceId: null,
  path: 'src/sessions/types.ts',
  severity: 'nit',
  category: 'style',
  title: '`usedAt` reads as a time, but it holds a flag',
  detail: 'Rename it to `used`.',
})

const caught = [reuseRace, leakedFamily, status401, naming]

function review(overrides: Partial<PrReviewStepState> = {}): PrReviewStepState {
  return {
    ...prReview('awaiting_selection'),
    prUrl: 'https://example.invalid/acme/auth/pull/231',
    summary:
      'The rotation is right in shape. The reuse check races, and one log line leaks a token.',
    slices,
    findings: caught,
    ...overrides,
  }
}

const read = { pathPrefix: storyWorkspacePrefix, pathParams: { executionId: 'exec_login' } }

/** The login run with the reviewer as its third step, opened in the window. */
function opened(
  state: PrReviewStepState,
  reviewer: Partial<PipelineStep> = {},
  api: HttpHandler = apiResponse(getPrReviewContract, { ...read, body: state }),
): Story {
  const run = execution({
    currentStep: 2,
    status: state.status === 'awaiting_selection' ? 'blocked' : 'running',
    steps: [
      step({ agentKind: 'architect', state: 'done', progress: 1 }),
      step({ agentKind: 'coder', state: 'done', progress: 1 }),
      step({
        agentKind: 'pr-reviewer',
        state: state.status === 'awaiting_selection' ? 'waiting_decision' : 'working',
        progress: 0.6,
        prReview: state,
        ...reviewer,
      }),
    ],
  })
  return {
    decorators: [
      withSeed(() => {
        seedSnapshot(snapshot({ executions: [run] }))
        seedResultView({
          view: 'pr-review',
          blockId: run.blockId,
          instanceId: run.id,
          stepIndex: 2,
        })
      }),
    ],
    parameters: { api: [api] },
  }
}

const meta = {
  title: 'Pipeline/Pages/PrReviewWindow',
  component: PrReviewWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PrReviewWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Four findings under two slices and the catch-all, most severe first, all selected, with Fix,
 * Post and Finish.
 */
export const Default: Story = opened(review())

/** The reviewer found nothing. */
export const Empty: Story = opened(review({ findings: [], summary: 'Nothing worth a comment.' }))

/** The read when the window opens failed: the error line over the findings from the board. */
export const Failed: Story = opened(review(), {}, apiFailure(getPrReviewContract, read))

/** The reviewer has not reported a slice plan yet: the neutral "reviewing" state, and Resume. */
export const Planning: Story = opened(review({ status: 'reviewing', findings: [], summary: null }))

/** The reviewer works through its slices: one done, one in progress, the aggregate queued. */
export const ReviewingSlices: Story = opened(
  review({ status: 'reviewing', findings: [], summary: null }),
  {
    subtasks: {
      ...subtasks(1, 3, 1),
      items: [
        { label: 'Refresh rotation', status: 'completed' },
        { label: 'Refresh endpoint', status: 'in_progress' },
        { label: 'Aggregate the findings', status: 'pending' },
      ],
    },
  },
)

/**
 * A person challenged the log finding and the investigator is at work on it; earlier challenges
 * retracted the naming nit and upheld the race.
 */
export const Challenging: Story = opened(
  review({
    status: 'challenging',
    findings: [
      { ...reuseRace, challenge: { status: 'upheld', justification: 'Both queries are real.' } },
      {
        ...leakedFamily,
        challenge: { status: 'investigating', question: 'Is this log line on in production?' },
      },
      status401,
      { ...naming, challenge: { status: 'retracted', justification: '`usedAt` is a time.' } },
    ],
  }),
)

/** The fixer commits the selected findings onto the branch. */
export const Fixing: Story = opened(review({ status: 'fixing' }))

/**
 * Posting as comments partly failed: three of four posted, one line is not in the diff, and the
 * review is back for a retry.
 */
export const PostReport: Story = opened(
  review({
    postedFindingIds: [reuseRace.id, leakedFamily.id, status401.id],
    postAttempts: 1,
    postReport: {
      attempted: 4,
      posted: 3,
      folded: 0,
      bodyPosted: true,
      failures: [
        {
          findingId: naming.id,
          path: naming.path,
          line: null,
          reason: 'The line is not part of the diff.',
        },
      ],
    },
  }),
)
