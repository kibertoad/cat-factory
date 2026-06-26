import { expect, test } from '@playwright/test'
import {
  createSeededWorkspace,
  createSimplePipeline,
  openBoard,
  pinWorkspace,
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
test.describe('live pipeline run', () => {
  test('start → live decision → resolve in UI → terminal, over the WebSocket', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    const workspaceId = snapshot.workspace.id
    const pipeline = await createSimplePipeline(request, workspaceId)

    await pinWorkspace(page, workspaceId)
    await openBoard(page)

    const card = taskCard(page, 'task_login')
    await expect(card).toHaveAttribute('data-status', 'planned')

    // Kick the run over REST — the SPA is already subscribed to this workspace's event stream.
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // LIVE: the run parks on the fake agent's decision. Both the toolbar badge and the
    // card's own "Decision needed" affordance are pushed in without a reload.
    await expect(page.getByTestId('decision-badge')).toBeVisible({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-status', 'blocked', { timeout: 30_000 })

    // Resolve it through the UI: the card's Resolve button opens the decision modal.
    await card.getByTestId('task-resolve').click()
    const modal = page.getByTestId('decision-modal')
    await expect(modal).toBeVisible()
    await modal.getByTestId('decision-option').first().click()

    // LIVE: the decision clears and the run advances to a terminal state (a merger-less
    // pipeline finishes at `pr_ready`; an auto-merged one at `done`).
    await expect(page.getByTestId('decision-badge')).toBeHidden({ timeout: 30_000 })
    await expect
      .poll(async () => await card.getAttribute('data-status'), { timeout: 45_000 })
      .toMatch(/^(pr_ready|done)$/)
  })
})
