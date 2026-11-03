import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  createInitiative,
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

  test('a click anywhere on a card opens the task, beside the queue rather than over it', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByTestId('work-view-queue').click()
    const card = page.locator('[data-testid="queue-card"][data-queue-task="task_login"]')
    await expect(card).toBeVisible()

    // Not the title: the empty space at the card's right edge.
    const box = (await card.boundingBox())!
    await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12)
    const inspector = page.getByTestId('inspector-panel')
    await expect(inspector).toHaveAttribute('data-inspector-block', 'task_login')

    // The columns make room for the panel, so the last one stays readable.
    const last = page.locator('[data-testid="queue-column"][data-column="ready_to_merge"]')
    await expect
      .poll(async () => {
        const col = await last.boundingBox()
        const panel = await inspector.boundingBox()
        return !!col && !!panel && col.x + col.width <= panel.x
      })
      .toBe(true)
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

  test('a decision on an initiative, which no swimlane holds, is listed under Needs you', async ({
    page,
    request,
    seededBoard,
  }) => {
    test.slow()
    const { workspaceId } = seededBoard
    // The fake agent's default parks the planning run's first step on a decision.
    const { block } = await createInitiative(request, workspaceId, 'blk_auth', 'preset_generic')
    await startRun(request, workspaceId, block.id, 'pl_initiative')
    await expect(page.getByTestId('decision-badge')).toBeVisible({ timeout: RUN_TERMINAL_TIMEOUT })

    // The badge counts it, so the queue it opens must list it, with the decision one click away.
    await page.getByTestId('decision-badge').click()
    const card = column(page, 'needs_you').locator(
      `[data-testid="queue-card"][data-queue-task="${block.id}"]`,
    )
    await expect(card).toHaveAttribute('data-reason', 'decision', { timeout: LIVE_TIMEOUT })
    await card.getByTestId('queue-card-primary').click()
    await expect(page.getByTestId('decision-modal')).toBeVisible()
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

    // A filter set earlier, to a service the decision is not in, must not hide it: the badge
    // counts decisions in every service, so it opens the queue on all of them.
    await page.getByTestId('work-view-queue').click()
    await page.getByTestId('queue-service-filter').click()
    await page.getByRole('option', { name: 'API Gateway' }).click()
    await page.getByTestId('work-view-board').click()

    await page.getByTestId('decision-badge').click()
    await expect(page.getByTestId('queue-view')).toBeVisible()
    await expect(
      column(page, 'needs_you').locator('[data-testid="queue-card"][data-queue-task="task_login"]'),
    ).toBeVisible({ timeout: LIVE_TIMEOUT })
  })
})
