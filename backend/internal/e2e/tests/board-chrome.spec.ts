import { INFRA_SETUP_DISMISSED_STORAGE_KEY } from '@cat-factory/contracts'
import { test, expect } from './fixtures'
import { createSeededWorkspace, openBoard, pinWorkspace } from './helpers'

// The board's top overlay region under the condition every other spec seeds away: a deployment
// with standing advisories to raise.
//
// `BoardTopOverlays` owns placement for the toolbar and every banner, and the property that
// buys is that no advisory can bury the board chrome. Nothing else can see that. A unit test
// reads class strings, so it catches a banner that re-anchors itself and not a stacking order
// that is wrong for some other reason; a backend assertion cannot see rendered geometry at all;
// and the failure is silent on any deployment that happens to have nothing to advise about.
// The last time this broke, the zoom and fit controls were unreachable for every operator with
// an unconfigured runner pool, and the board-basics tour rang a control nobody could see.
test.describe('board chrome under standing advisories', () => {
  test('keeps the toolbar visible and hittable with every advisory raised', async ({
    page,
    request,
  }) => {
    const snapshot = await createSeededWorkspace(request)
    await pinWorkspace(page, snapshot.workspace.id)
    // `pinWorkspace` permanently dismisses the infra-setup advisories so they stay out of every
    // other spec's way. This spec is about them, so put them back BEFORE the first navigation
    // (a later init script wins, and there is no reload to hide a placement bug behind).
    await page.addInitScript(
      (key) => window.localStorage.removeItem(key),
      INFRA_SETUP_DISMISSED_STORAGE_KEY,
    )
    await openBoard(page)

    // The advisories really did render, or every assertion below is vacuous. The e2e backend is
    // a stock Node deployment with no runner pool registered, so this is the real card.
    const advisory = page.locator('[data-testid^="infra-setup-banner-"]').first()
    await expect(advisory).toBeVisible()

    // The tour's own anchor, and the everyday zoom control beside it.
    const fitView = page.getByTestId('board-fit-view')
    await expect(fitView).toBeVisible()

    // Hittable, not merely present: `toBeVisible` passes on a control buried under a banner,
    // which is exactly what shipped.
    const box = (await fitView.boundingBox())!
    const hit = await page.evaluate(
      ([x, y]) =>
        document
          .elementFromPoint(x as number, y as number)
          ?.closest('[data-testid]')
          ?.getAttribute('data-testid') ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    expect(hit).toBe('board-fit-view')

    // And the advisory stacks BELOW the toolbar rather than merely beside it, which is what
    // keeps the toolbar's position independent of how many advisories a deployment raises.
    const advisoryBox = (await advisory.boundingBox())!
    expect(advisoryBox.y).toBeGreaterThanOrEqual(box.y + box.height)
  })
})
