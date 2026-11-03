import { test, expect } from './fixtures'

// The setup checklist (issue #2258) states, in one list, what the setup banners and startup
// dialogs state one by one. The e2e backend is a stable subject for that: it connects a faked
// GitHub and registers no runner pool, so one row must read done and another missing, and a
// row's action must land on the same surface its banner opens.
test.describe('setup checklist', () => {
  test('lists what is set up and what is missing, and opens the surface that fixes a row', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await page.getByTestId('nav-setup-checklist').click()
    const checklist = page.getByTestId('setup-checklist')
    await expect(checklist).toBeVisible()

    const row = (id: string) => checklist.locator(`[data-testid="setup-row"][data-row="${id}"]`)
    await expect(row('sourceControl')).toHaveAttribute('data-status', 'done')
    await expect(row('agentExecutor')).toHaveAttribute('data-status', 'missing')

    // The runner row opens the Infrastructure window, as the runner banner does, and the
    // checklist closes rather than stacking under it.
    await row('agentExecutor').getByTestId('setup-row-action').click()
    await expect(page.getByTestId('infrastructure-tabs')).toBeVisible()
    await expect(checklist).toBeHidden()
  })
})
