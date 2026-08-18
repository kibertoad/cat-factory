import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, selectTask, taskCard } from './helpers'

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
    // A basic-mode destination, so this holds at the shipped default tier. It also proves the
    // drawer is never RAILED: the collapsed rail is lg-only, so below lg the labels render.
    await expect(page.getByTestId('sidebar').getByText('Workspace settings')).toBeVisible()

    // Tapping the backdrop closes the drawer (backdrop unmounts). Tap the dimmed strip BESIDE the
    // panel, which is the only part of the backdrop a user can actually reach — and the reason
    // this needs a position at all: the backdrop is `fixed inset-0`, so Playwright's default click
    // point is its centre (x≈195 on this 390px viewport), which sits INSIDE the 256px-wide drawer.
    // The drawer then intercepts the click, and the retry loop can never win, so the test hangs to
    // its full 60s. It passed at all only when the click happened to land while the 200ms open
    // transition still had the panel part-way off-screen — a race against an animation, not a
    // property of the affordance. Derived from the panel's measured width so a restyle can't
    // silently put the tap point back underneath it.
    const drawerWidth = (await page.getByTestId('sidebar').boundingBox())?.width ?? 0
    expect(drawerWidth).toBeGreaterThan(0)
    await page.getByTestId('sidebar-backdrop').click({ position: { x: drawerWidth + 40, y: 422 } })
    await expect(page.getByTestId('sidebar-backdrop')).toBeHidden()
  })

  test('selecting a task opens the inspector as a bottom sheet', async ({ page, seededBoard }) => {
    void seededBoard

    // The subject is the sheet's PLACEMENT, so selection just has to be reliable: `selectTask`
    // takes the card's title and waits for the panel to name this block.
    await selectTask(taskCard(page, 'task_login').first())
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
