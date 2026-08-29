import { test, expect } from './fixtures'
import { LIVE_TIMEOUT, taskCard } from './helpers'

// A service frame's rendered footprint is a function of the SPA's lane geometry, and the seeded
// board's coordinates are authored in `kernel`'s `seedBlocks()`. Nothing type-checks the two
// against each other, and nothing can: only the assembled product knows how big a frame actually
// draws. So this is the check that has to live here.
//
// It earns its place because the failure it catches does not look like a layout bug. A frame that
// overlaps its neighbour draws ON TOP of that neighbour's cards, and a covered card cannot be
// clicked at all — the click lands on the frame above it and no handler runs. That is what the
// swimlanes did to the seeded board when a populated frame outgrew a grid pitch authored for the
// old free canvas: three unrelated specs went red with lost clicks and blamed the run they were
// driving. This one names the actual cause instead.
//
// The SPA now holds this as a standing invariant rather than by luck of the authored pitch:
// `useFrameOverlapGuard` bounces any two top-level board nodes that come to overlap apart. So
// read a failure here as the guard not reaching these frames (or not running at all), not as a
// seed pitch to re-tune. Both still earn their place: the seed is authored to clear without help,
// and this spec is the only thing that measures what the assembled product actually draws.
test.describe('seeded board layout', () => {
  test('no seeded service frame overlaps another', async ({ page, seededBoard }) => {
    void seededBoard
    const ids = ['blk_frontend', 'blk_api', 'blk_payments', 'blk_auth', 'blk_db', 'blk_queue']

    // Wait for the one frame whose size depends on its contents: the others are empty, so they
    // reach their final footprint immediately, while this one only does once its tasks arrive.
    await expect(taskCard(page, 'task_login')).toBeVisible({ timeout: LIVE_TIMEOUT })

    const boxes = await Promise.all(
      ids.map(async (id) => ({
        id,
        box: await taskCard(page, id).first().boundingBox(),
      })),
    )
    for (const { id, box } of boxes) expect(box, `${id} has no box`).not.toBeNull()

    // Screen-space is fine: the whole board renders at one zoom, so an overlap here is an overlap
    // in flow-space too. Compared pairwise rather than against an expected pitch, because the
    // pitch is exactly the thing under test.
    const overlaps: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!.box!
        const b = boxes[j]!.box!
        const clears =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
        if (!clears) overlaps.push(`${boxes[i]!.id} overlaps ${boxes[j]!.id}`)
      }
    }
    expect(overlaps, 'seeded frames must clear each other').toEqual([])
  })
})
