import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  createSeededWorkspace,
  createSimplePipeline,
  openBoard,
  pinWorkspace,
  setFakeProfile,
  startRun,
} from './helpers'

// The queue view (issue #2258): the board's second view, beside the canvas. These specs pin the
// claims it makes: a person who has not chosen lands on it and the view they pick is remembered;
// it states the SAME lane verdict the canvas does, so answering a decision there moves the task
// out LIVE; and the canvas's decision counter leads to it.

const column = (page: Page, id: string) =>
  page.locator(`[data-testid="queue-column"][data-column="${id}"]`)

test.describe('queue view', () => {
  test('a person who has not chosen lands on the queue, and the view they pick is remembered', async ({
    page,
    request,
  }) => {
    // Not the `seededBoard` fixture: it opens every spec on the canvas.
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)
    // Remove the view choice the helper records, so this is a person who has never chosen.
    await page.context().clearCookies({ name: 'workView' })
    await openBoard(page)
    await expect(page.getByTestId('queue-view')).toBeVisible()

    await page.getByTestId('work-view-board').click()
    await expect(page.getByTestId('queue-view')).toHaveCount(0)

    // A fresh load opens on the view picked last, not on the default.
    await openBoard(page)
    await expect(page.getByTestId('queue-view')).toHaveCount(0)
    await expect(page.getByTestId('work-view-board')).toHaveAttribute('aria-current', 'page')
  })

  test('a parked decision is listed under Needs you, and answering it there moves it out', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await page.getByTestId('work-view-queue').click()
    await expect(page.getByTestId('queue-view')).toBeVisible()
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [0] })
    const pipeline = await createSimplePipeline(request, workspaceId)
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    const card = column(page, 'needs_you').locator(
      '[data-testid="queue-card"][data-queue-task="task_login"]',
    )
    await expect(card).toHaveAttribute('data-reason', 'decision', { timeout: LIVE_TIMEOUT })

    // The card's primary action IS the gate: one click to the decision, one to answer it.
    const modal = page.getByTestId('decision-modal')
    await card.getByTestId('queue-card-primary').click()
    await expect(modal).toBeVisible()
    await modal.getByTestId('decision-option').first().click()
    await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })

    // Nothing is waiting on a person any more, so the card cannot come back to this column.
    await expect(card).toHaveCount(0, { timeout: LIVE_TIMEOUT })
    await expect(
      page.locator('[data-testid="queue-card"][data-queue-task="task_login"]'),
    ).toHaveCount(1)
  })

  test("the canvas's decision counter opens the queue view", async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [0] })
    const pipeline = await createSimplePipeline(request, workspaceId)
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    await page.getByTestId('decision-badge').click()
    await expect(page.getByTestId('queue-view')).toBeVisible()
    await expect(
      column(page, 'needs_you').locator('[data-testid="queue-card"][data-queue-task="task_login"]'),
    ).toBeVisible({ timeout: LIVE_TIMEOUT })
  })
})
