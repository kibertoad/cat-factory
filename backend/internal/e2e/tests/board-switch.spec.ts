import { test, expect } from './fixtures'
import {
  LIVE_TIMEOUT,
  createSeededWorkspace,
  createTask,
  openBoard,
  pinWorkspace,
  switchBoard,
  taskCard,
} from './helpers'

// SWITCHING BOARDS: the affordance every other spec bypasses, and the one that moves the live
// connection.
//
// A deployment is many boards, and a person moves between them all day from the sidebar switcher.
// Every other spec PINS its board client-side before the first paint, so nothing covers the switch
// itself, and a switch is not a navigation: the SPA re-hydrates the board in place and the
// per-workspace WebSocket has to be re-subscribed to the board now on screen. When that half is
// missed, the product looks perfectly healthy: the new board's blocks are all there (the REST
// snapshot fetched them), and the failure only shows later, as a board that never updates while
// someone works on it. That is the defect this spec exists to catch, so the load-bearing assertion
// is not "the switch happened" but "a change made on the NEW board arrives with no reload, and one
// made on the OLD board does not".
//
// Both boards are seeded (and GitHub-connected) over REST BEFORE the first paint: the switcher's
// rows come from the board list the SPA hydrates on load, so a board created afterwards is not in
// it. They are NAMED, because the sample architecture uses fixed block ids and two seeded boards
// are otherwise identical on screen. Which of the two a cold load opens is the product's own
// resolution and no business of this spec's, so it switches to A deliberately: the board it starts
// from is then a fact it established, not one inherited from the order it seeded them in.
test.describe('board switching (the live connection follows the board)', () => {
  test('switch boards from the sidebar → live updates follow the new board, not the old', async ({
    page,
    request,
  }) => {
    const boardA = await createSeededWorkspace(request, 'E2E board A')
    const boardB = await createSeededWorkspace(request, 'E2E board B')
    const workspaceA = boardA.workspace.id
    const workspaceB = boardB.workspace.id

    await pinWorkspace(page, workspaceA)
    await openBoard(page)
    await switchBoard(page, workspaceA)
    const switcher = page.getByTestId('board-switcher')

    // Switch to board B from the switcher's own menu (its rows are addressable by board id).
    await switchBoard(page, workspaceB)

    // The board on screen is B: its canvas paints from B's snapshot, and the switcher names it.
    await expect(page.getByTestId('board-canvas')).toBeVisible()
    // The name a person reads. Basic mode ships the sidebar as an icon RAIL, where the switcher
    // carries its board's name in the tooltip rather than as text, so that is where it is asserted.
    await expect(switcher).toHaveAttribute('title', 'E2E board B')
    // The real-time channel reports connected again, for a subscription this spec has yet to prove
    // is pointed at B (a stale one reports connected just as happily).
    await expect(page.getByTestId('workspace-stream')).toHaveAttribute('data-connected', 'true', {
      timeout: LIVE_TIMEOUT,
    })

    // THE ASSERTION, in two halves that have to be ordered this way round.
    //
    // Author on the board we LEFT first, then on the board we are ON. Waiting for B's card is then
    // also the wait that would have surfaced A's: both events were emitted before the wait began,
    // so B's arrival means a subscription still bound to A had every chance to render A's card.
    // Asserting the absence on its own would pass on a push that simply had not landed yet, a
    // check that cannot fail, which is worse than no check.
    const onA = await createTask(request, workspaceA, 'blk_auth', 'Authored on board A')
    const onB = await createTask(request, workspaceB, 'blk_auth', 'Authored on board B')
    await expect(taskCard(page, onB.id)).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(taskCard(page, onA.id)).toHaveCount(0)

    // Switching BACK reaches the other board's own live state: the card authored on A while it was
    // off screen is there on arrival (it came with the snapshot), and the one authored on B is not.
    await switchBoard(page, workspaceA)
    await expect(taskCard(page, onA.id)).toBeVisible({ timeout: LIVE_TIMEOUT })
    await expect(taskCard(page, onB.id)).toHaveCount(0)
  })
})
