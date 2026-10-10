import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, createSimplePipeline, setFakeProfile, startRun } from './helpers'

// The queue-first preview (issue #2258): a second shell, switched on per browser. These specs
// pin the three claims it makes: the queue states the SAME lane verdict the board does (a parked
// decision is under "Needs you", and answering it from there moves it out LIVE), the intake files
// a task from one sentence, and switching the preview off restores the current product exactly.

/** Switch the preview on through the palette, the route the PR documents beside the link. */
async function enablePreview(page: Page): Promise<void> {
  await page.getByTestId('command-bar-launcher').click()
  await expect(page.getByTestId('command-bar')).toBeVisible()
  await page.getByTestId('command-home-preview').click()
  await expect(page.getByTestId('queue-view')).toBeVisible({ timeout: LIVE_TIMEOUT })
}

const column = (page: Page, id: string) =>
  page.locator(`[data-testid="queue-column"][data-column="${id}"]`)

test.describe('queue-first preview', () => {
  test('a parked decision is listed under Needs you, and answering it there moves it out', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    await enablePreview(page)
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [0] })
    const pipeline = await createSimplePipeline(request, workspaceId)
    await startRun(request, workspaceId, 'task_login', pipeline.id)

    const card = column(page, 'needs_you').locator(
      '[data-testid="queue-card"][data-block-id="task_login"]',
    )
    await expect(card).toHaveAttribute('data-reason', 'decision', { timeout: LIVE_TIMEOUT })

    // The card's primary action IS the gate: one click to the decision, one to answer it.
    const modal = page.getByTestId('decision-modal')
    await card.getByTestId('queue-card-primary').click()
    await expect(modal).toBeVisible()
    await modal.getByTestId('decision-option').first().click()
    await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })

    // Nothing is waiting on a human any more, so the card cannot come back to this column.
    await expect(card).toHaveCount(0, { timeout: LIVE_TIMEOUT })
    await expect(
      page.locator('[data-testid="queue-card"][data-block-id="task_login"]'),
    ).toHaveCount(1)
  })

  test('one sentence and a service file a task under Not started', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await enablePreview(page)

    await page.getByTestId('queue-describe-work').click()
    const dialog = page.getByTestId('describe-work-modal')
    await expect(dialog).toBeVisible()
    await dialog
      .getByTestId('describe-work-text')
      .fill('Add a resend link to the sign-in page. Allow one resend every 30 seconds.')
    // The derived title is shown before submit, so nobody is surprised by what the card says.
    await expect(dialog.getByTestId('describe-work-title')).toContainText(
      'Add a resend link to the sign-in page',
    )
    await dialog.getByTestId('describe-work-service').click()
    await page.getByRole('option', { name: 'Auth Service' }).click()
    await page.getByTestId('describe-work-add').click()

    const filed = column(page, 'in_flight').locator('[data-testid="queue-card"]', {
      hasText: 'Add a resend link to the sign-in page',
    })
    await expect(filed).toHaveAttribute('data-reason', 'unstarted', { timeout: LIVE_TIMEOUT })
  })

  test('switching the preview off restores the board', async ({ page, seededBoard }) => {
    void seededBoard
    await enablePreview(page)
    await page.getByTestId('home-preview-leave').click()

    await expect(page.getByTestId('queue-view')).toHaveCount(0)
    await expect(page.getByTestId('home-preview-nav')).toHaveCount(0)
    await expect(page.getByTestId('board-canvas')).toBeVisible()
  })
})
