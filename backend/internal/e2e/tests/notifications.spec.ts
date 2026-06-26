import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  resolveDecision,
  startRun,
  taskCard,
} from './helpers'

// A merger-less pipeline that reaches `pr_ready` raises a `pipeline_complete` notification —
// a first-class, human-actionable surface pushed live over the same WebSocket the board uses.
// These specs drive a real run to `pr_ready`, then exercise the inbox END-TO-END in the real
// SPA: the bell appears live, the item is the right type, and acting / dismissing resolves it.
//
// NOTE on scope: the e2e backend has GitHub OFF, so "Confirm & merge" can't perform a real
// merge (there is no PR) — the task is NOT expected to flip to `done` here. The merge SIDE-
// EFFECT is covered by the backend conformance/integration suites; what's deterministic (and
// uniquely an e2e concern) is the live notification surface + that acting RESOLVES the
// notification. Each test seeds its own workspace (the `seededBoard` fixture).
test.describe('notifications inbox', () => {
  // These tests drive a full run before touching the inbox; give them the slow budget.
  test.slow()

  /** Drive `task_login` through the default decision gate to `pr_ready` (raising the
   * `pipeline_complete` notification). Returns the task card locator. */
  async function runToPrReady(
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
    workspaceId: string,
  ) {
    const pipeline = await createSimplePipeline(request, workspaceId)
    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })
    await resolveDecision(page, card)
    await expect(card).toHaveAttribute('data-status', 'pr_ready', {
      timeout: RUN_TERMINAL_TIMEOUT,
    })
    return card
  }

  test('pipeline_complete arrives live; acting resolves it', async ({
    page,
    request,
    seededBoard,
  }) => {
    await runToPrReady(page, request, seededBoard.workspaceId)

    // LIVE: the inbox bell is pushed in (the popover only renders once there's an open
    // notification), and the item is the expected `pipeline_complete` type.
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="pipeline_complete"]',
    )
    await expect(item).toBeVisible()

    // Act ("Confirm & merge"): the backend runs the side-effect and resolves the
    // notification, so LIVE the bell clears (no more open notifications).
    await item.getByTestId('notification-act').click()
    await expect(bell).toBeHidden({ timeout: LIVE_TIMEOUT })
  })

  test('dismissing the notification clears the bell and leaves the task pr_ready', async ({
    page,
    request,
    seededBoard,
  }) => {
    const card = await runToPrReady(page, request, seededBoard.workspaceId)

    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="pipeline_complete"]',
    )
    await expect(item).toBeVisible()

    // Dismiss: the bell clears, and the task is left untouched at `pr_ready` (no merge).
    await item.getByTestId('notification-dismiss').click()
    await expect(bell).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'pr_ready')
  })
})
