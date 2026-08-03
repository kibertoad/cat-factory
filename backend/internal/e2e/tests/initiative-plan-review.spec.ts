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
//
// The second spec covers what the rail REVIEWS. The planner emits its plan as JSON and returns a
// transcript summary as its output, so the gate used to park on a one-line proposal: a rail with
// nothing to read, no way to navigate a long plan, and no way to say which part needed changing —
// and a "request changes" that handed that sentence back to the planner as its previous proposal.
// The engine now renders the ingested plan onto the gate (`renderInitiativePlanForReview`), so the
// rail carries the document itself, its outline, and per-block comments.

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

  test('the rail reviews the rendered plan: outline, per-block comment, send back', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard

    const pipeline = await createSimplePipeline(request, workspaceId, ['architect'])
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      initiativePlan: plan(pipeline.id),
    })

    const { block } = await createInitiative(request, workspaceId, 'blk_auth', 'preset_generic')
    const card = page.getByTestId('initiative-card')
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })
    await startRun(request, workspaceId, block.id, 'pl_initiative')

    const review = card.getByTestId('initiative-card-review')
    await expect(review).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
    await review.click()

    const tracker = page.getByTestId('initiative-tracker-window')
    await expect(tracker).toBeVisible({ timeout: LIVE_TIMEOUT })
    const rail = tracker.getByTestId('initiative-plan-review')
    await expect(rail).toBeVisible()

    // The gate parked on the PLAN, not on the planner's transcript summary: the document carries
    // the plan's own prose and an outline to navigate it by.
    const doc = rail.getByTestId('initiative-plan-document')
    await expect(doc).toContainText('Ship the thing, in one reviewed phase.')
    await expect(doc).toContainText('Do the phase-one work')
    await expect(doc).toContainText('The only item of the plan awaiting approval.')
    await expect(rail.getByTestId('initiative-plan-toc')).toBeVisible()

    // ...and it is the ONLY copy of the plan on screen. The review owns the window while the gate is
    // parked, precisely because the tracker's own goal/phase sections render the same ingested plan:
    // when they shipped together, a reviewer scrolled a 20rem document with a second copy of it
    // underneath. Counting the goal is the cheapest way to pin that — it was 2 before.
    await expect(tracker.getByText('Ship the thing, in one reviewed phase.')).toHaveCount(1)
    // Taking the window does NOT cost the run details (model, run id, token telemetry): they move
    // into the outline sidebar rather than disappearing for the duration of the review.
    await expect(rail.getByTestId('initiative-plan-run-meta')).toBeVisible()
    // The two shapes of this gate are mutually exclusive. The compact notice is for a gate whose
    // step rendered nothing, and it points at the tracker's sections as the plan — printed over the
    // takeover, which replaced those sections, it would be pointing at nothing.
    await expect(tracker.getByTestId('initiative-plan-notice')).toHaveCount(0)

    // Send back is refused until there is something to re-plan FROM.
    await expect(rail.getByTestId('initiative-plan-send-back')).toBeDisabled()

    // Comment on a specific block of the plan (GitHub-review style: click the block, write the
    // note) — the anchoring the rail had no way to express.
    await doc.locator('.reader-prose [data-src-start]').first().click()
    const composer = rail.getByTestId('initiative-plan-composer')
    await expect(composer).toBeVisible()
    await composer.getByTestId('initiative-plan-comment-body').fill('Split this into two items.')
    await composer.getByTestId('initiative-plan-comment-add').click()
    await expect(rail.getByTestId('initiative-plan-comment')).toHaveCount(1)

    // One anchored comment is enough to send back, with or without overall feedback.
    const sendBack = rail.getByTestId('initiative-plan-send-back')
    await expect(sendBack).toBeEnabled()
    const sentGate = await rail.getAttribute('data-approval-id')
    expect(sentGate, 'the rail publishes the gate it is reviewing').toBeTruthy()
    await sendBack.click()

    // LIVE: the planner re-runs with the review folded in and parks again on a NEW gate — the loop
    // the gate exists for.
    //
    // Asserted on WHICH gate is on screen, not on the rail disappearing in between. The rail is
    // driven by the pending approval, and the send-back's own `ws.refresh()` races the re-plan: a
    // fast planner parks again before that snapshot is taken, so the SPA can go straight from one
    // gate to the next and the "no approval" window need never exist. Waiting for it was a race
    // this spec lost intermittently in CI while proving nothing the id does not prove better.
    await expect(rail).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })
    await expect(rail).not.toHaveAttribute('data-approval-id', sentGate ?? '', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })

    // The drafts do not survive the round: the returning rail reviews the NEW plan clean.
    await expect(rail.getByTestId('initiative-plan-comment')).toHaveCount(0)

    // The initiative is still awaiting approval — a send-back must never commit the plan.
    const pending = await getInitiative(request, workspaceId, block.id)
    expect(pending?.status).not.toBe('executing')
  })
})
