import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createSimplePipeline,
  setFakeProfile,
  startRun,
  taskCard,
} from './helpers'

// The merge-lifecycle review gate. A pipeline that ends in a `merger` step scores the PR and,
// when the assessment is OVER the task's auto-merge threshold, does NOT merge — it raises a
// `merge_review` notification and leaves the task `pr_ready` for a human. This complements
// `notifications.spec` (which covers the merger-LESS `pipeline_complete`) by covering the
// distinct `merge_review` type from a real merger step.
//
// The low confidence that makes the merger assessment "severe" is requested PER WORKSPACE via
// the fake-profile control channel (`confidence: 0.2`), so no other spec is affected; the
// default step-0 decision is disabled so the run flows straight through to the merger.
test.describe('merge review', () => {
  test.slow()

  test('a low-confidence merger raises a live merge_review notification; dismiss leaves pr_ready', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [], confidence: 0.2 })
    const pipeline = await createSimplePipeline(request, workspaceId, [
      'architect',
      'coder',
      'merger',
    ])

    const card = taskCard(page, 'task_login')
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    // The merger declines to auto-merge → the task settles at `pr_ready` (NOT `done`).
    await expect(card).toHaveAttribute('data-status', 'pr_ready', { timeout: RUN_TERMINAL_TIMEOUT })

    // LIVE: the inbox bell is pushed in and the open item is the `merge_review` type.
    const bell = page.getByTestId('notifications-bell')
    await expect(bell).toBeVisible({ timeout: LIVE_TIMEOUT })
    await bell.click()
    const item = page.locator(
      '[data-testid="notification-item"][data-notification-type="merge_review"]',
    )
    await expect(item).toBeVisible()

    // Dismiss: the bell clears and the task is left untouched at `pr_ready` (no merge happened).
    await item.getByTestId('notification-dismiss').click()
    await expect(bell).toBeHidden({ timeout: LIVE_TIMEOUT })
    await expect(card).toHaveAttribute('data-status', 'pr_ready')
  })
})
