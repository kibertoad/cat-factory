import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// Slice 5 of the modular-vue adoption (docs/initiatives/modular-vue-slice5-progress.md):
// every agent-run result window now renders inside the shared `ResultWindowShell`, which
// centralises the modal chrome AND owns the modal *behaviour* via the upstream
// `useModalBehavior` — focus-trap, body-scroll lock, and a shared overlay stack so Escape
// closes the top overlay. Before slice 5 each of the ~18 windows hand-rolled this, and only
// 2 trapped focus / each registered its own Escape listener.
//
// This drives the pilot window (`MergerResultView`) through the REAL SPA to assert the shell
// renders and closes on all three paths the shell now owns — the close button, Escape, and a
// backdrop click. The merger step is reached with a low-confidence merger (no auto-merge, so
// the step settles with a verdict to inspect), the same setup as `merge-review.spec`.
test.describe('result-window shell (merger)', () => {
  test.slow()

  test('opens the merger window in the shared shell; closes on button / Escape / backdrop', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // Low confidence ⇒ the merger declines to auto-merge and leaves a verdict on the step;
    // the default step-0 decision is disabled so the run flows straight to the merger.
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [], confidence: 0.2 })
    const pipeline = await createSimplePipeline(request, workspaceId, [
      'architect',
      'coder',
      'merger',
    ])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)
    // The run drives through the merger and settles at `pr_ready` (pushed live).
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // Open the task inspector and locate the completed merger step in its run panel.
    await card.click()
    const mergerStep = page.locator('[data-testid="run-step"][data-step-kind="merger"]')
    await expect(mergerStep).toBeVisible({ timeout: LIVE_TIMEOUT })

    const dialog = page.getByTestId('result-window')
    const backdrop = page.getByTestId('result-window-backdrop')

    // Clicking the merger step routes to its dedicated result window — rendered in the shell.
    async function openWindow(): Promise<void> {
      await mergerStep.locator('button').first().click()
      await expect(dialog).toBeVisible()
      // The shell hosts the merger verdict body (the decision banner) — proves the window's
      // own content renders inside the shared chrome, not just an empty shell.
      await expect(dialog.getByTestId('merger-decision')).toBeVisible()
    }

    // 1) The shell's standard close button.
    await openWindow()
    await dialog.getByTestId('result-window-close').click()
    await expect(dialog).toBeHidden()

    // 2) Escape — now owned by the shell's `useModalBehavior` (the shared overlay stack), not
    //    the window's old per-window listener. This is the behaviour slice 5 centralised.
    await openWindow()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // 3) A click on the backdrop itself (top-left corner, outside the centered panel).
    await openWindow()
    await backdrop.click({ position: { x: 5, y: 5 } })
    await expect(dialog).toBeHidden()
  })
})
