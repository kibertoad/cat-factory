import { test, expect } from './fixtures'

// Phase 3 of the mobile-friendly work — the board canvas on a phone. The minimap is a
// precise-pointer affordance (too small to hit on a phone, and it eats scarce width), so
// it's hidden below `lg`; the toolbar's zoom + fit-view controls remain the camera
// fallback. We assert that DOM-level responsive split here (a static `isCompact` gate, not
// a pushed event). The touch pan/pinch gestures themselves are Vue Flow configuration
// (`panOnDrag`/`zoomOnPinch` + `touch-action: none`), not something a Playwright spec drives.
test.describe('mobile board canvas', () => {
  // A typical modern phone (iPhone 12/13/14 logical size). Below `lg`, so `isCompact`.
  test.use({ viewport: { width: 390, height: 844 } })

  test('hides the minimap but keeps the zoom/fit camera fallback reachable', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard

    // The minimap is gated off below `lg` (v-if), so it isn't in the DOM at all.
    await expect(page.getByTestId('board-minimap')).toBeHidden()

    // Its replacement — the toolbar camera controls — stays one tap away.
    await expect(page.getByTestId('board-zoom-out')).toBeVisible()
    await expect(page.getByTestId('board-zoom-in')).toBeVisible()
    await expect(page.getByTestId('board-fit-view')).toBeVisible()
  })
})
