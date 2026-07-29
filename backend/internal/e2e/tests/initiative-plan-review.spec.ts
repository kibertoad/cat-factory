import { expect, test } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createInitiative,
  createSimplePipeline,
  findParkedApproval,
  getInitiative,
  setFakeProfile,
  startRun,
} from './helpers'

// The assembled-product proof of the initiative PLANNER's human gate — the review surface the
// planning run parks on once the plan is drafted.
//
// It exists because that gate used to be a dead end in the SPA. The planner emits its plan as
// JSON and returns "Initiative plan drafted." as its output, so the gate parked on a one-line
// proposal; and the planner step routed to the read-only tracker window, which carries no
// approve / request-changes / reject rail. The only way through was a REST call — which is what
// `initiative-checkpoint.spec.ts` and `tech-migration-preset.spec.ts` still do to set up.
//
// So this spec asserts the two halves of the fix together, since neither is worth much alone:
// the gate parks on the PLAN ITSELF (rendered as a navigable document by
// `renderInitiativePlanForReview`), and the board offers a route to a review surface that can
// actually resolve it — comment on a part of the plan, leave overall feedback, request changes,
// approve.
//
// Per the e2e spec shape every UI assertion is on live, WebSocket-pushed state; the run is never
// reloaded. The two REST reads are SEQUENCING, not assertions: a request-changes round re-runs
// the planner and re-parks it on a NEW approval id, and clicking the board affordance while that
// re-run is still in flight would open nothing. Polling the snapshot for the new gate is the same
// "observe backend-only progression" the sibling initiative specs use, and unlike watching the
// button blink it cannot race the re-park.

/**
 * The plan the fake `initiative-planner` returns. Its headings are what the reader navigates.
 * The pipeline the items spawn onto is only known at runtime, so the plan is built after it is
 * created — a lean `coder`-only one, since what happens to the spawned items is not the subject
 * here and a full build pipeline would drag a deployer + tester into the run for nothing.
 */
function plan(pipelineId: string) {
  return {
    goal: 'Replace the legacy notification path with the notification-channel port.',
    constraints: ['No downtime during the cutover'],
    nonGoals: ['Rewriting the Slack integration'],
    analysisSummary: 'The legacy path is reached from three call sites.',
    phases: [
      { id: 'phase-one', title: 'Introduce the port' },
      { id: 'phase-two', title: 'Retire the legacy path' },
    ],
    items: [
      {
        id: 'itm_port',
        phaseId: 'phase-one',
        title: 'Add the notification-channel port',
        description: 'Define the port in kernel and implement it on both facades.',
        estimate: { complexity: 0.4, risk: 0.2, impact: 0.8, rationale: 'Well-understood seam.' },
      },
      {
        id: 'itm_retire',
        phaseId: 'phase-two',
        title: 'Delete the legacy notifier',
        description: 'Remove the old module once every call site moved.',
        dependsOn: ['itm_port'],
      },
    ],
    policy: { maxConcurrent: 1, defaultPipelineId: pipelineId, rules: [] },
    decisions: [{ title: 'A port over a direct rewrite', detail: 'Keeps each PR reviewable.' }],
    caveats: ['The legacy notifier has no tests.'],
  }
}

test.describe('initiative plan review gate', () => {
  // Drives a full planning run (interviewer → analyst → planner) to its human gate, then a
  // request-changes round that re-runs the planner — many durable steps, so the slow budget.
  test.slow()

  test('the planner gate parks on the plan; comment → request changes → approve', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder'])

    // The fake inline interviewer converges on its first pass, so the run reaches the planner
    // without a human answering anything; the planner then returns the plan above.
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      confidence: 1,
      initiativePlan: plan(pipeline.id),
    })

    const { block } = await createInitiative(request, workspaceId, 'blk_auth', 'preset_generic')
    const card = page.getByTestId('initiative-card')
    await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT })

    await startRun(request, workspaceId, block.id, 'pl_initiative')

    // LIVE: the card grows a "Review plan" affordance the moment the planner's gate is raised.
    // This is the surface that did not exist — the gate was reachable only over REST.
    const reviewPlan = card.getByTestId('initiative-card-review-plan')
    await expect(reviewPlan).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })

    await reviewPlan.click()
    const detail = page.getByTestId('step-detail')
    await expect(detail).toBeVisible()

    // The gate parked on the PLAN, not on the planner's transcript summary: the document's own
    // headings are rendered, and the outline sidebar navigates them.
    await expect(detail.getByTestId('step-detail-toc')).toBeVisible()
    await expect(detail).toContainText('Phase 1: Introduce the port')
    await expect(detail).toContainText('Add the notification-channel port')
    await expect(detail).toContainText(
      'Define the port in kernel and implement it on both facades.',
    )

    // The plan is a RENDERING of the already-ingested entity, so editing it in place would reach
    // nothing: the edit affordance is replaced by the note that says so.
    await expect(detail.getByTestId('step-rendered-output-note')).toBeVisible()

    // The gate id this round, so the re-park below is provably a NEW one rather than this one
    // observed again.
    const first = await findParkedApproval(request, workspaceId, block.id, 'initiative-planner')
    expect(first).not.toBeNull()

    // Comment on a specific part of the plan (GitHub-review style: click the block, write the
    // note), then leave overall feedback and send it back.
    await detail.locator('.reader-prose [data-src-start]').first().click()
    const composer = detail.getByTestId('step-review-composer')
    await expect(composer).toBeVisible()
    await composer.getByTestId('step-review-comment-body').fill('Split this into two items.')
    await composer.getByTestId('step-review-comment-add').click()
    await expect(detail.getByTestId('step-review-comment')).toHaveCount(1)

    await detail.getByTestId('step-review-feedback').fill('Phase two needs a rollback plan.')
    await detail.getByTestId('step-request-changes').click()

    // The review closes on the accepted request, and the planner re-runs with the feedback. The
    // fake returns the same plan, so it parks again — on a fresh approval id.
    await expect(detail).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect
      .poll(
        async () => {
          const parked = await findParkedApproval(
            request,
            workspaceId,
            block.id,
            'initiative-planner',
          )
          return parked !== null && parked.approvalId !== first!.approvalId
        },
        { timeout: RUN_TERMINAL_TIMEOUT },
      )
      .toBe(true)

    // LIVE: the re-park reaches the board on its own, and this time approve from the review.
    await expect(reviewPlan).toBeVisible({ timeout: LIVE_TIMEOUT })
    await reviewPlan.click()
    await expect(detail).toBeVisible()
    await detail.getByTestId('step-approve').click()
    await expect(detail).toBeHidden({ timeout: LIVE_TIMEOUT })

    // The committer persists the approved plan and arms the execution loop.
    await expect
      .poll(async () => (await getInitiative(request, workspaceId, block.id))?.status ?? null, {
        timeout: RUN_TERMINAL_TIMEOUT,
      })
      .toMatch(/^(executing|done)$/)
  })
})
