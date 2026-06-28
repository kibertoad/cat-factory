import { test, expect } from './fixtures'

// Phase 3 of the mobile-friendly work — the board canvas on a phone. The minimap was
// removed altogether (a precise-pointer affordance too small to hit on touch and a
// width hog on narrow windows — it earned its keep on neither desktop nor mobile), so
// the toolbar's zoom + fit-view controls are the only camera navigation on every
// viewport. We assert that camera fallback is reachable at a phone viewport and that no
// minimap is rendered. The touch pan/pinch gestures themselves are Vue Flow
// configuration (`panOnDrag`/`zoomOnPinch` + `touch-action: none`), not something a
// Playwright spec drives — the pure pan-mode decision (`[0, 2]` blocks one-finger pan,
// so touch widens to `true`) is unit-tested in `boardPanMode.spec.ts`.
test.describe('mobile board canvas', () => {
  // A typical modern phone (iPhone 12/13/14 logical size). Below `lg`, so `isCompact`.
  test.use({ viewport: { width: 390, height: 844 } })

  test('keeps the zoom/fit camera controls reachable with no minimap', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    // The toolbar camera controls are the board's navigation on a phone.
    await expect(page.getByTestId('board-zoom-out')).toBeVisible()
    await expect(page.getByTestId('board-zoom-in')).toBeVisible()
    await expect(page.getByTestId('board-fit-view')).toBeVisible()

    // The minimap was removed entirely — it isn't in the DOM on any viewport.
    await expect(page.getByTestId('board-minimap')).toHaveCount(0)
  })
})
