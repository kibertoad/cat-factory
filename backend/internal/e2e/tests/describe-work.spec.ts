import { test, expect } from './fixtures'

// The one-sentence intake (issue #2258): a sentence and a service file a task. The title comes
// from the first sentence and is shown before submit; every other kind of task stays in the full
// form, which this dialog hands the text to.
test.describe('describe new work', () => {
  test('one sentence and a service file a task, titled by its first sentence', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await page.getByTestId('nav-describe-work').click()
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
    await expect(dialog).toBeHidden()

    // It lands on the canvas like any other new task: planned, in its service's Not started lane.
    const card = page.locator('[data-testid="task-card"]', {
      hasText: 'Add a resend link to the sign-in page',
    })
    await expect(card).toHaveAttribute('data-status', 'planned')
  })

  test('"More kinds" hands the text to the full form, prefilled', async ({ page, seededBoard }) => {
    void seededBoard
    await page.getByTestId('nav-describe-work').click()
    const dialog = page.getByTestId('describe-work-modal')
    const text = 'Spike: compare two rate-limit libraries. Measure p99 latency under load.'
    await dialog.getByTestId('describe-work-text').fill(text)
    await dialog.getByTestId('describe-work-service').click()
    await page.getByRole('option', { name: 'Auth Service' }).click()
    await dialog.getByTestId('describe-work-kind-bug').click()
    await dialog.getByTestId('describe-work-more-kinds').click()

    const full = page.getByTestId('add-task-modal')
    await expect(full).toBeVisible()
    await expect(dialog).toBeHidden()
    await expect(full.getByTestId('add-task-title')).toHaveValue(
      'Spike: compare two rate-limit libraries',
    )
    // Nothing the person wrote or chose is dropped: the whole text is the description, and the
    // kind they picked is the one selected.
    await expect(full.getByTestId('add-task-description')).toHaveValue(text)
    await expect(full.getByTestId('task-type-bug')).toHaveAttribute('aria-pressed', 'true')
  })

  test('closing with typed text asks first, and keeping it keeps the text', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await page.getByTestId('nav-describe-work').click()
    const dialog = page.getByTestId('describe-work-modal')
    const box = dialog.getByTestId('describe-work-text')
    await box.fill('Add a resend link to the sign-in page.')
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('confirm-dialog')).toBeVisible()
    await page.getByTestId('confirm-cancel').click()
    await expect(dialog).toBeVisible()
    await expect(box).toHaveValue('Add a resend link to the sign-in page.')
  })
})
