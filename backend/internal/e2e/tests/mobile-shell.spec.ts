import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, taskCard } from './helpers'

// The responsive shell on a phone-sized viewport. The board chrome (sidebar, toolbar,
// inspector) is desktop-first by default; below `lg` (1024px) the sidebar becomes an
// off-canvas drawer behind a hamburger and the inspector becomes a bottom sheet. These
// assert the LIVE behaviour of those affordances — drawer open/close via the backdrop
// (a real v-if mount/unmount, not just an off-screen transform) and that nothing
// overflows the viewport horizontally — rather than any pushed-event round-trip.
test.describe('mobile responsive shell', () => {
  // A typical modern phone (iPhone 12/13/14 logical size). Below `lg`, so `isCompact`.
  test.use({ viewport: { width: 390, height: 844 } })

  test('sidebar is an off-canvas drawer toggled by the hamburger', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    // The hamburger is the compact-only nav trigger; the backdrop only exists while open.
    const hamburger = page.getByTestId('mobile-nav-toggle')
    await expect(hamburger).toBeVisible()
    await expect(page.getByTestId('sidebar-backdrop')).toBeHidden()

    // Open the drawer → the backdrop mounts and a nav action inside is reachable.
    await hamburger.click()
    await expect(page.getByTestId('sidebar-backdrop')).toBeVisible()
    await expect(page.getByTestId('sidebar').getByText('Build a pipeline')).toBeVisible()

    // Tapping the backdrop closes the drawer (backdrop unmounts).
    await page.getByTestId('sidebar-backdrop').click()
    await expect(page.getByTestId('sidebar-backdrop')).toBeHidden()
  })

  test('selecting a task opens the inspector as a bottom sheet', async ({ page, seededBoard }) => {
    void seededBoard

    await taskCard(page, 'task_login').getByTestId('task-card').first().click()
    const inspector = page.getByTestId('inspector-panel')
    await expect(inspector).toBeVisible({ timeout: LIVE_TIMEOUT })
    // The sheet is pinned to the bottom edge of the viewport on compact widths.
    const box = await inspector.boundingBox()
    expect(box).not.toBeNull()
    if (box) expect(box.y + box.height).toBeGreaterThan(844 - 2)
  })

  test('the board chrome does not overflow the viewport horizontally', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
