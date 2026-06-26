import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  resolveDecision,
  startRun,
  taskCard,
} from './helpers'

// The flagship e2e: a real run drives the board LIVE over the WebSocket.
//
// We seed + trigger over REST (deterministic, no fragile canvas drag-and-drop), but every
// assertion is on the real SPA reacting to REAL pushed events — there is NO reload between
// starting the run and observing the board change. The fake agent (booted with
// `E2E_DECISION_ON_STEPS=0`, the default) parks the first step on a human decision, so the
// full gate flow is exercised: run parks → SPA shows the decision live → human resolves it
// in the UI → run resumes and the task reaches a terminal state, all pushed over the WS.
//
// The merger-less pipeline finishing at `pr_ready` also raises a `pipeline_complete`
// notification — asserted by `notifications.spec.ts`, not here, so this spec stays focused
// on the decision-gate round-trip.
test.describe('live pipeline run', () => {
  // Drives a full run through several durable steps; give it the slow budget.
  test.slow()

  test('start → live decision → resolve in UI → terminal, over the WebSocket', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const pipeline = await createSimplePipeline(request, workspaceId)

    const card = taskCard(page, 'task_login')
    await expect(card).toHaveAttribute('data-status', 'planned')

    // Kick the run over REST — the SPA is already subscribed to this workspace's event stream.
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the run parks on the fake agent's decision. Both the toolbar badge and the
    // card's own "Decision needed" affordance are pushed in without a reload.
    await expect(page.getByTestId('decision-badge')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })

    // Resolve it through the UI (asserts the decision modal actually closes too).
    await resolveDecision(page, card)

    // LIVE: the decision clears and the run advances to a terminal state (a merger-less
    // pipeline finishes at `pr_ready`; an auto-merged one at `done`).
    await expect(page.getByTestId('decision-badge')).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect
      .poll(async () => await card.getAttribute('data-status'), { timeout: RUN_TERMINAL_TIMEOUT })
      .toMatch(/^(pr_ready|done)$/)
  })
})
