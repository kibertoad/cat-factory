import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The companion rework loop, an agent retry loop the widened FakeProfile now reaches. A companion
// step (here `reviewer`, whose target is `coder`) grades the producer; a below-threshold rating
// loops the producer back with the feedback folded in, on an automatic budget. When that budget is
// spent WITHOUT converging, the run parks on the iteration-cap decision (one more round / proceed /
// stop-reset) and raises a `decision_required` notification. This spec drives a persistently-failing
// grade so the loop reaches its cap and parks — proving the loop is observable end-to-end.
//
// The persistent rating (`companionRating: 0.4`) is requested over the fake-profile control channel;
// the default step-0 decision is disabled so the run flows straight into the review loop.
test.describe('companion rework loop (iteration cap)', () => {
  test.slow()

  test('a persistently-failing review loops to its cap, parks the run, and raises a live decision_required notification', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      companionRating: 0.4,
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder', 'reviewer'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The automatic rework budget is spent without converging → the run parks `blocked` at the
    // iteration cap (NOT auto-passed and not silently failed), pushed live.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: the iteration-cap decision is surfaced in the inbox as a `decision_required` card.
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="decision_required"]',
    )
    await expect(item).toBeVisible()
  })
})
