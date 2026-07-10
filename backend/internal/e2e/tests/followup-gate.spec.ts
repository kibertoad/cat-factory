import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The Follow-up companion gate, an agent retry loop the widened FakeProfile now reaches. When the
// async `coder` surfaces forward-looking follow-ups / questions, the run parks at the Coder's
// completion until each item is decided (filed as an issue, sent back, answered, or dismissed) and
// raises a `followup_pending` notification. This spec drives the coder to stream one follow-up and
// proves the park + notification reach the live UI.
//
// The streamed follow-ups (`followUps: [...]`) and the async coder kind are requested over the
// fake-profile control channel; the default step-0 decision is disabled so the run flows straight
// into the coder.
test.describe('follow-up companion gate', () => {
  test.slow()

  test('a coder that surfaces follow-ups parks the run and raises a live followup_pending notification', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, {
      decisionOnSteps: [],
      asyncKinds: ['coder'],
      followUps: [
        { kind: 'follow_up', title: 'Confirm the login copy', detail: 'wording pending design' },
      ],
    })
    const pipeline = await createSimplePipeline(request, workspaceId, ['coder'])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The coder streams a follow-up on its first poll → the run parks `blocked` at its completion
    // until the item is decided, pushed live.
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: the follow-ups-to-decide card lands in the inbox as a `followup_pending` notification.
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="followup_pending"]',
    )
    await expect(item).toBeVisible()
  })
})
