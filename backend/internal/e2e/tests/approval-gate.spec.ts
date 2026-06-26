import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  resolveDecision,
  startRun,
  taskCard,
} from './helpers'

// A per-step human APPROVAL gate (distinct from an agent-raised decision): the pipeline marks
// a step `gates[i] = true`, so the run pauses AFTER that step completes for a human to review
// its output and Approve/Request-changes/Reject in the full-screen step-detail rail. This spec
// exercises that rail end-to-end in the real SPA.
//
// On the default e2e backend step 0 ALSO raises a one-shot decision (E2E_DECISION_ON_STEPS=0),
// so the architect step here parks twice in sequence: first on the decision (resolved as in the
// flagship run spec), then — once it re-runs and completes — on the approval gate. That gives us
// the approval surface without a second backend, and incidentally proves the two gate types
// compose on one step.
test.describe('human approval gate', () => {
  // Drives a full run through two sequential gates; give it the slow budget.
  test.slow()

  test('architect parks for approval → Approve in the step rail → run advances', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // Gate the (non-final) architect step; the coder step (final) runs straight through.
    const pipeline = await createSimplePipeline(
      request,
      workspaceId,
      ['architect', 'coder'],
      [true, false],
    )

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // First park: the agent-raised decision (resolve it through the UI).
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: LIVE_TIMEOUT })
    await resolveDecision(page, card)

    // Second park: once the architect re-runs and completes, the approval gate holds the run.
    // The card's action button flips from "Resolve" (decision) to "Approve" (approval).
    const resolve = card.getByTestId('task-resolve')
    await expect(resolve).toHaveText(/approve/i, { timeout: RUN_TERMINAL_TIMEOUT })

    // Open the full-screen step-detail and approve in its review rail.
    await resolve.click()
    const detail = page.getByTestId('step-detail')
    await expect(detail).toBeVisible()
    await detail.getByTestId('step-approve').click()

    // LIVE: the gate clears and the run advances to a terminal state (coder finishes).
    await expect
      .poll(async () => await card.getAttribute('data-status'), { timeout: RUN_TERMINAL_TIMEOUT })
      .toMatch(/^(pr_ready|done)$/)
  })
})
