import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, taskCard } from './helpers'

// Create a task through the REAL UI (the add-task modal), not over REST — so the whole
// client path is exercised: the frame's "Add task" button opens the modal, the form posts
// to the real backend, and the new card appears on the board. Complements the REST-seeded
// specs by covering the one board mutation users perform by hand most often.
test.describe('create a task via the UI', () => {
  test('add a task to a frame → the new card appears on the board', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    const title = 'E2E created task'

    // Open the add-task modal from the Auth Service frame's header button.
    await taskCard(page, 'blk_auth').getByTestId('frame-add-task').first().click()
    const modal = page.getByTestId('add-task-modal')
    await expect(modal).toBeVisible()

    // Fill the title (Nuxt UI forwards the data-testid onto the <input> itself) and submit.
    await modal.getByTestId('add-task-title').fill(title)
    await page.getByTestId('add-task-submit').click()

    // The modal closes and the new task card appears under the frame in `planned` state.
    await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })
    const newCard = taskCard(page, 'blk_auth').getByTestId('task-card').filter({ hasText: title })
    await expect(newCard).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(newCard).toHaveAttribute('data-status', 'planned')
  })
})
