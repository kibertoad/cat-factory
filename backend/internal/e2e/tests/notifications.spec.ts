import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  resolveDecision,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The inbox END-TO-END in the real SPA, over notifications pushed live on the same WebSocket the
// board uses. Each spec drives a real run to the state that raises its card: `pr_ready` (a
// merger-less pipeline raises `pipeline_complete`), or a park on a decision or an approval gate
// (`decision_required`). It then checks that the bell appears live, the item has the right type,
// and that acting, dismissing or the card's verb does what it says.
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

  test('a parked decision carries "Answer", which opens the decision to answer', async ({
    page,
    request,
    seededBoard,
  }) => {
    const pipeline = await createSimplePipeline(request, seededBoard.workspaceId)
    const card = taskCard(page, 'task_login')
    await startRun(request, seededBoard.workspaceId, 'task_login', pipeline.id)
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })

    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="decision_required"]',
    )
    await expect(item).toBeVisible()

    // The card's primary button reads "Answer". Its label waits for the run to be parked in the
    // store (until then it reads "Open"), so the click below cannot land before the decision has.
    // It opens the decision window, where the question is answered, and the inbox closes.
    const goTo = item.getByTestId('notification-go-to')
    await expect(goTo).toHaveText('Answer')
    await goTo.click()
    const modal = page.getByTestId('decision-modal')
    await expect(modal).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(item).toBeHidden()
    await modal.getByTestId('decision-option').first().click()
    await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })
  })

  test('a parked approval gate carries "Answer", which opens the step to approve', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // No agent question: the run parks only on the approval gate after the architect step.
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [] })
    const pipeline = await createSimplePipeline(
      request,
      workspaceId,
      ['architect', 'coder'],
      [true, false],
    )
    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(card.getByTestId('task-resolve')).toHaveText(/approve/i, {
      timeout: LIVE_TIMEOUT,
    })

    await page.getByTestId('notifications-bell').click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="decision_required"]',
    )
    const goTo = item.getByTestId('notification-go-to')
    await expect(goTo).toHaveText('Answer')
    await goTo.click()
    const detail = page.getByTestId('step-detail')
    await expect(detail).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(detail.getByTestId('step-approve')).toBeVisible()
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
