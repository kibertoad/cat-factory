import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  startRun,
  taskCard,
} from './helpers'

// The destructive run-lifecycle control: a parked run can be DISCARDED from the task
// inspector ("Reset"), which cancels the execution and returns the task to `planned` —
// the dual of resolving a decision (run.spec) or approving a gate (approval-gate.spec).
// Nothing else covers the cancel/reset path through the real SPA, so this exercises the
// `cancelExecution` controller end-to-end and asserts the board reacts LIVE (the parked
// card flips back to `planned` and the decision badge clears) with no reload.
//
// On the default e2e backend step 0 raises a one-shot decision (E2E_DECISION_ON_STEPS=0),
// so the run reliably PARKS — giving us a live, in-flight run to reset without racing a
// fast fake to completion. We never resolve the decision; we reset out from under it.
test.describe('reset a parked run', () => {
  test('Reset in the inspector discards the run → task returns to planned, live', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    const pipeline = await createSimplePipeline(request, workspaceId)

    const card = taskCard(page, 'task_login')
    await expect(card).toHaveAttribute('data-status', 'planned')

    // Kick the run; it parks live on the first step's decision (badge + blocked card).
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    await expect(page.getByTestId('decision-badge')).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })

    // Open the task inspector (a card-body click only selects — it never pops the
    // decision modal), then hit the destructive Reset control on its run panel.
    await card.click()
    const reset = page.getByTestId('run-reset')
    await expect(reset).toBeVisible()
    await reset.click()

    // LIVE: the run is gone — the card returns to `planned` and the decision badge clears,
    // pushed over the WebSocket with no reload.
    await expect(card).toHaveAttribute('data-status', 'planned', { timeout: RUN_TERMINAL_TIMEOUT })
    await expect(page.getByTestId('decision-badge')).toBeHidden({ timeout: LIVE_TIMEOUT })
  })
})
