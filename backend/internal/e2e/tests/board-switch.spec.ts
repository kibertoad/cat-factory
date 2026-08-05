import { test, expect } from './fixtures'
import {
  BOOT_TIMEOUT,
  LIVE_TIMEOUT,
  createSeededWorkspace,
  createTask,
  openBoard,
  pinWorkspace,
  taskCard,
} from './helpers'

// SWITCHING BOARDS: the affordance every other spec bypasses, and the one that moves the live
// connection.
//
// A deployment is many boards, and a person moves between them all day from the sidebar switcher.
// Every other spec PINS its board client-side before the first paint, so nothing covers the switch
// itself — and a switch is not a navigation: the SPA re-hydrates the board in place and the
// per-workspace WebSocket has to be re-subscribed to the board now on screen. When that half is
// missed, the product looks perfectly healthy: the new board's blocks are all there (the REST
// snapshot fetched them), and the failure only shows later, as a board that never updates while
// someone works on it. That is the defect this spec exists to catch, so the load-bearing assertion
// is not "the switch happened" but "a change made on the NEW board arrives with no reload, and one
// made on the OLD board does not".
//
// Both boards are seeded (and GitHub-connected) over REST BEFORE the first paint: the switcher's
// rows come from the board list the SPA hydrates on load, so a board created afterwards is not in
// it. They are NAMED, because the sample architecture uses fixed block ids — two seeded boards are
// otherwise identical on screen.
test.describe('board switching (the live connection follows the board)', () => {
  test('switch boards from the sidebar → live updates follow the new board, not the old', async ({
    page,
    request,
  }) => {
    // Board B is seeded FIRST and board A second, because A is the one this spec opens: on the
    // dev-open backend `pinWorkspace` restores nothing (the persisted stores are cookie-backed) and
    // the SPA opens the NEWEST board in the list. Creating them the other way round would open B
    // and quietly invert the whole spec.
    const boardB = await createSeededWorkspace(request, 'E2E board B')
    const boardA = await createSeededWorkspace(request, 'E2E board A')
    const workspaceA = boardA.workspace.id
    const workspaceB = boardB.workspace.id

    await pinWorkspace(page, workspaceA)
    await openBoard(page)
    const switcher = page.getByTestId('board-switcher')
    await expect(switcher).toHaveAttribute('data-board-id', workspaceA)

    // Switch to board B from the switcher's own menu (its rows are addressable by board id).
    await switcher.click()
    await page.getByTestId(`board-option-${workspaceB}`).click()

    // The board on screen is B: its canvas paints from B's snapshot, and the switcher names it.
    await expect(switcher).toHaveAttribute('data-board-id', workspaceB, { timeout: BOOT_TIMEOUT })
    await expect(page.getByTestId('board-canvas')).toBeVisible()
    // The name a person reads. Basic mode ships the sidebar as an icon RAIL, where the switcher
    // carries its board's name in the tooltip rather than as text, so that is where it is asserted.
    await expect(switcher).toHaveAttribute('title', 'E2E board B')
    // The real-time channel reports connected again — for a subscription this spec has yet to
    // prove is pointed at B (a stale one reports connected just as happily).
    await expect(page.getByTestId('workspace-stream')).toHaveAttribute('data-connected', 'true', {
      timeout: LIVE_TIMEOUT,
    })

    // THE ASSERTION, in two halves that have to be ordered this way round.
    //
    // Author on the board we LEFT first, then on the board we are ON. Waiting for B's card is then
    // also the wait that would have surfaced A's: both events were emitted before the wait began,
    // so B's arrival means a subscription still bound to A had every chance to render A's card.
    // Asserting the absence on its own would pass on a push that simply had not landed yet — a
    // check that cannot fail, which is worse than no check.
    const onA = await createTask(request, workspaceA, 'blk_auth', 'Authored on board A')
    const onB = await createTask(request, workspaceB, 'blk_auth', 'Authored on board B')
    await expect(taskCard(page, onB.id)).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(taskCard(page, onA.id)).toHaveCount(0)

    // Switching BACK reaches the other board's own live state: the card authored on A while it was
    // off screen is there on arrival (it came with the snapshot), and the one authored on B is not.
    await switcher.click()
    await page.getByTestId(`board-option-${workspaceA}`).click()
    await expect(switcher).toHaveAttribute('data-board-id', workspaceA, { timeout: BOOT_TIMEOUT })
    await expect(taskCard(page, onA.id)).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(taskCard(page, onB.id)).toHaveCount(0)
  })
})
