import type { Meta, StoryObj } from '@storybook/vue3'
import { getExecutionContract, getKaizenRunGradingsContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import type { ExecutionInstance } from '~/types/domain'
import type { PipelineStep } from '~/types/execution'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { forkDecisionState } from '~/stories/forkDecision.stories.mocks'
import { kaizenGrading } from '~/stories/kaizen.stories.mocks'
import {
  approval,
  blockedInputGate,
  companionVerdicts,
  failure,
  step,
} from '~/stories/pipelineStep.stories.mocks'
import { modelOption } from '~/stories/providers.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedModelCatalog, seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import AgentStepDetail from './AgentStepDetail.vue'

// One step of a run, over the whole screen: the step's details first, then what the step left
// (its prose as sections under a contents list), and whatever holds it: an
// approval gate with its review rail, a companion's rework cap, the check before dispatch, or a
// park that another window owns. The step opens from the inspector or the focus view
// (`ui.openStepDetail`). The board holds each run whole here, so the read that makes a projected
// run whole sends nothing, except in `Loading` and `Error`. The run is the login task's, and its
// steps are each story's own. Every button sends a request no story answers.

const started = Date.UTC(2026, 9, 14, 9, 0)

/** The architect's plan, as the step wrote it. */
const plan = `Rotate the refresh token on every use, and treat a reused token as a theft.

## Changes

### Session store

Mint a new refresh token in \`rotateRefresh\`, and keep the previous one as **used** for one
minute, so a request that is already in flight still succeeds.

### Refresh endpoint

Call \`rotateRefresh\` on every refresh. A token marked as used after its minute revokes the whole
session family.

## Tests

- A refresh returns a new token, and the old one fails after a minute.
- A reused token revokes every session of the family.

## Risks

The gateway caches tokens for thirty seconds. That is shorter than the minute above, so the two
do not conflict.`

const architectDone = step({
  agentKind: 'architect',
  state: 'done',
  progress: 1,
  startedAt: started,
  finishedAt: started + 7 * 60_000 + 30_000,
  output: plan,
})

/** The login run on the build pipeline: the architect done, the coder at work. */
function loginRun(steps: PipelineStep[], overrides: Partial<ExecutionInstance> = {}) {
  return execution({ steps, currentStep: 1, ...overrides })
}

const coderWorking = step({
  agentKind: 'coder',
  state: 'working',
  progress: 0.3,
  startedAt: started + 8 * 60_000,
})
const reviewerPending = step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 })

/** The run's Kaizen gradings: none by default. */
function gradings(...rows: ReturnType<typeof kaizenGrading>[]): HttpHandler {
  return apiResponse(getKaizenRunGradingsContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { executionId: 'exec_login' },
    body: { gradings: rows },
  })
}

/**
 * Step `stepIndex` of `run` opened, with `api` answering the requests. `direct` sets the open step
 * without the router that sends a step to its own window: the state of a step whose park arrives
 * while this panel is already open. `graded` gives the run's gradings; without it, the run has
 * none.
 */
function opened(
  run: ExecutionInstance,
  stepIndex: number,
  api: HttpHandler[] = [],
  { direct = false, graded = gradings() } = {},
): Story {
  return {
    decorators: [
      withSeed(() => {
        seedModelCatalog([modelOption()])
        seedSnapshot(snapshot({ executions: [run] }))
        if (direct) useUiStore().stepDetail = { instanceId: run.id, stepIndex }
        else useUiStore().openStepDetail(run.id, stepIndex)
      }),
    ],
    parameters: { api: [...api, graded] },
  }
}

const meta = {
  title: 'Pipeline/Pages/AgentStepDetail',
  component: AgentStepDetail,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AgentStepDetail>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The architect's finished plan while the coder works: the details card, and the plan in sections,
 * with the contents list beside it. Kaizen grades nothing before the run is done.
 */
export const Default: Story = opened(loginRun([architectDone, coderWorking, reviewerPending]), 0)

/**
 * The run is done, so Kaizen graded it (`KaizenService` grades only a finished run): the grade and
 * the recommendation under the architect's plan.
 */
export const Graded: Story = {
  ...opened(
    loginRun(
      [
        architectDone,
        { ...coderWorking, state: 'done', progress: 1, finishedAt: started + 40 * 60_000 },
        { ...reviewerPending, state: 'done', progress: 1 },
      ],
      { status: 'done', currentStep: 2 },
    ),
    0,
    [],
    {
      graded: gradings(
        kaizenGrading({
          id: 'kz_login_architect',
          stepIndex: 0,
          agentKind: 'architect',
          grade: 4,
          summary:
            'A clear plan that names the in-flight case. It does not say how to roll it out.',
          recommendations: ['State the rollout order when a change touches two services.'],
        }),
      ),
    },
  ),
  play: async () => {
    await screen.findByText('4/5')
  },
}

/** The board's run withholds the prose, and the whole run is still on its way. */
const projected = loginRun(
  [{ ...architectDone, output: undefined }, coderWorking, reviewerPending],
  {
    projected: true,
  },
)
const runRead = { pathPrefix: storyWorkspacePrefix, pathParams: { executionId: 'exec_login' } }

/** The read of the whole run has not answered: the load line over a reader with no prose. */
export const Loading: Story = opened(projected, 0, [apiPending(getExecutionContract, runRead)])

/** The read of the whole run failed: the load line says so. */
export const Error: Story = opened(projected, 0, [apiFailure(getExecutionContract, runRead)])

/** The coder at work with no prose yet: the live clock, and the empty state. */
export const Working: Story = opened(loginRun([architectDone, coderWorking, reviewerPending]), 1)

/** The plan parked at its gate after seven and a half minutes, so its clock is stopped. */
const gated = {
  ...architectDone,
  state: 'waiting_decision' as const,
  finishedAt: undefined,
  pausedAt: started + 7 * 60_000 + 30_000,
}

/**
 * The plan waits at its gate: the badge in the header, and the review rail with Approve, Approve
 * with corrections, Request changes and Reject. A click on a block of the plan comments on it.
 */
export const ApprovalPending: Story = opened(
  loginRun(
    [{ ...gated, approval: approval({ id: 'appr_login_plan' }) }, coderWorking, reviewerPending],
    {
      status: 'blocked',
      currentStep: 0,
    },
  ),
  0,
)

/**
 * The step's output is a rendering of something it already stored, so the rail offers no
 * corrections and says why.
 */
export const RenderedOutputApproval: Story = opened(
  loginRun(
    [
      { ...gated, outputIsRendered: true, approval: approval({ id: 'appr_login_plan' }) },
      coderWorking,
      reviewerPending,
    ],
    { status: 'blocked', currentStep: 0 },
  ),
  0,
)

/**
 * The architect's companion used its two rounds and a blocker is still open: the cap prompt
 * (one more round, go on, or stop) in place of the review rail.
 */
export const CompanionCapReached: Story = opened(
  loginRun(
    [
      {
        ...gated,
        approval: approval({ id: 'appr_login_cap' }),
        companion: {
          threshold: 0.75,
          maxAttempts: 2,
          attempts: 2,
          verdicts: companionVerdicts,
          exceeded: true,
        },
      },
      coderWorking,
      reviewerPending,
    ],
    { status: 'blocked', currentStep: 0 },
  ),
  0,
)

/**
 * The check before dispatch blocked the run on its first step: the findings, with Check again and
 * Proceed, in the step itself.
 */
export const InputGateBlocked: Story = opened(
  loginRun(
    [
      step({
        agentKind: 'architect',
        state: 'waiting_decision',
        progress: 0,
        approval: approval({ id: 'appr_login_input' }),
      }),
      step({ agentKind: 'coder', state: 'pending', progress: 0 }),
      reviewerPending,
    ],
    { status: 'blocked', currentStep: 0, inputGate: blockedInputGate },
  ),
  0,
)

/**
 * The coder parked on a choice of how to build it while its step was open here: the button that
 * opens the window for that choice. A click on such a step opens that window instead.
 */
export const DedicatedPark: Story = opened(
  loginRun(
    [
      architectDone,
      {
        ...coderWorking,
        state: 'waiting_decision',
        pausedAt: started + 9 * 60_000,
        forkDecision: forkDecisionState(),
      },
      reviewerPending,
    ],
    { status: 'blocked' },
  ),
  1,
  [],
  { direct: true },
)

const lostContainer = failure({
  message: 'The coder container was lost mid-run.',
  occurredAt: started + 30 * 60_000,
  stepIndex: 1,
})

/** The coder failed for the second time: the step history opened on both attempts. */
export const FailedWithHistory: Story = {
  ...opened(
    loginRun([architectDone, { ...coderWorking, progress: 0.7 }, reviewerPending], {
      status: 'failed',
      failure: failure({
        message: 'The tests still fail after three fix rounds.',
        occurredAt: started + 52 * 60_000,
        stepIndex: 1,
      }),
      failureHistory: [lostContainer],
    }),
    1,
  ),
  play: async () => {
    await userEvent.click(await screen.findByTestId('step-execution-history-toggle'))
    await screen.findAllByTestId('step-history-failure-entry')
  },
}
