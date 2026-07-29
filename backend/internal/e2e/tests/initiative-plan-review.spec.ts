import { expect, test } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createInitiative,
  createSimplePipeline,
  getInitiative,
  setFakeProfile,
  startRun,
} from './helpers'

// The assembled-product proof that an initiative's PLAN-APPROVAL gate is reachable AND resolvable
// from the UI. `pl_initiative` gates the planner step, so a finished planning pass parks the run on
// a pending `step.approval` — but the board card offered only a spinning "Run planning" and the
// tracker window (where the planner's park routes) was read-only, so the gate could be cleared by
// nothing except a REST call. Both halves are asserted here: the card surfaces the park live, and
// the window it opens actually clears it.
//
// The other initiative specs keep approving that gate over REST deliberately — there it is a
// TRIGGER on the way to their own subject (a checkpoint, a preset decoration), not the thing under
// test. This spec is where the UI path itself is pinned.

// The plan the fake `initiative-planner` returns. `preset_generic` declares no phase template, so
// it passes through the ingest normalizer unchanged. One item, routed to a trivial pipeline via
// `policy.defaultPipelineId` (its id is only known at runtime, hence the factory).
function plan(pipelineId: string) {
  return {
    goal: 'Ship the thing, in one reviewed phase.',
    analysisSummary: 'One phase is enough; the work is contained.',
    phases: [{ id: 'phase-one', title: 'Phase one' }],
    items: [
      {
        id: 'itm_p1',
        phaseId: 'phase-one',
        title: 'Do the phase-one work',
        description: 'The only item of the plan awaiting approval.',
      },
    ],
    policy: { maxConcurrent: 1, defaultPipelineId: pipelineId, rules: [] },
  }
}

test.describe('initiative plan review', () => {
  // A full planning run (interviewer → analyst → planner → gate) plus the committer wave after the
  // approval — many durable pg-boss steps — so give it the slow budget.
  test.slow()

  test('the board card offers the parked plan review, and the tracker window clears it', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard

    const pipeline = await createSimplePipeline(request, workspaceId, ['architect'])
    // Disable the default one-shot agent decision gate (so the analyst doesn't park on a decision
    // instead), and feed the planner the plan above. Set BEFORE the run starts.
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      initiativePlan: plan(pipeline.id),
    })

    // The initiative is created over REST (the create BUTTON is advanced-tier; the card it lands on
    // is not), so the spec runs on the shipped default tier like its sibling initiative specs.
    const { block } = await createInitiative(request, workspaceId, 'blk_auth', 'preset_generic')
    const card = page.getByTestId('initiative-card')
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

    await startRun(request, workspaceId, block.id, 'pl_initiative')

    // LIVE: the fake interviewer converges on its first pass → analyst → planner returns the plan →
    // the run parks on the planner's gate, and the card swaps its "Run planning" button for the
    // review affordance. This is the regression: the park used to leave the card on a disabled,
    // spinning "Run planning" with no route in except the inspector's step list.
    const review = card.getByTestId('initiative-card-review')
    await expect(review).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
    await expect(review).toHaveAttribute('data-attention', 'approval')

    // The card's button opens the window that OWNS the park (the planner's result view), which
    // carries the approve / request-changes rail beside the plan it judges.
    await review.click()
    const tracker = page.getByTestId('initiative-tracker-window')
    await expect(tracker).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(tracker.getByTestId('initiative-plan-review')).toBeVisible()

    await tracker.getByTestId('initiative-plan-approve').click()

    // LIVE: the approval advances the run to the committer, which persists the plan and arms the
    // execution loop — pushed to the anchor card's status over the WebSocket.
    await expect(card).toHaveAttribute('data-status', 'executing', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    // The rail goes with the park it resolved, in the window still open beside it.
    await expect(tracker.getByTestId('initiative-plan-review')).toBeHidden()

    // The plan really was committed (not merely acknowledged in the UI): the entity carries the
    // planner's phase + item, off the same snapshot the SPA hydrates from.
    const committed = await getInitiative(request, workspaceId, block.id)
    expect(committed?.status).toBe('executing')
    expect(committed?.items.map((i) => i.phaseId)).toEqual(['phase-one'])
  })
})
