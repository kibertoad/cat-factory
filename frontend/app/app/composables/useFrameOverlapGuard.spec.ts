import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameOverlapGuard } from '~/composables/useFrameOverlapGuard'
import { EMPTY_FRAME_SIZE, FRAME_GAP, framesCollide } from '~/utils/framePlacement'

/**
 * The guard is the wiring around `resolveFrameOverlaps` (whose geometry is pinned in
 * `framePlacement.spec.ts`). What is worth testing here is not the bouncing but the two policies
 * layered over it, because both are invisible in the geometry and both were wrong once:
 *
 * - WHEN it corrects: never against the geometry of a gesture still under the pointer, because
 *   those corrections displace frames the user is only dragging past.
 * - WHO writes the correction back: only the client whose own gesture caused it, and only through
 *   `moveBlock`, whose rollback needs to find the position the server actually holds.
 */
const canWriteBoard = ref(true)

function frame(id: string, x: number, y: number): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x, y },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
  }
}

interface Write {
  id: string
  to: { x: number; y: number }
  /** What the STORE still held when the write was asked for: the value a rollback restores. */
  storedAtCall: { x: number; y: number }
}

describe('useFrameOverlapGuard', () => {
  let scope: EffectScope
  let board: ReturnType<typeof useBoardStore>
  let writes: Write[]

  beforeEach(() => {
    canWriteBoard.value = true
    vi.stubGlobal('useUiStore', () => ({ zoom: 1 }))
    vi.stubGlobal('useWorkspaceAccess', () => ({ canWriteBoard }))
    board = useBoardStore()
    writes = []
    // Stands in for the real `moveBlock`, which records nothing but does apply its position
    // optimistically before the round-trip, which is the behaviour the guard leans on to correct the view
    // and write it in one act. The snapshot is taken BEFORE that, so the rollback assertion below
    // reads the position the real one would restore to.
    board.moveBlock = ((id: string, to: { x: number; y: number }) => {
      writes.push({ id, to, storedAtCall: { ...board.getBlock(id)!.position } })
      board.previewMove(id, to)
      return Promise.resolve()
    }) as unknown as typeof board.moveBlock
    // The composables under test reach the store through Nuxt's auto-import, which plain Vitest
    // does not provide; hand them the same instance the assertions read.
    vi.stubGlobal('useBoardStore', () => board)
    scope = effectScope()
  })

  afterEach(() => scope.stop())

  /** Start the guard over the frames the board currently holds and let its first pass run. */
  async function guard() {
    scope.run(() => useFrameOverlapGuard())
    await nextTick()
  }

  const rectOf = (id: string) => ({ ...board.getBlock(id)!.position, ...EMPTY_FRAME_SIZE })
  const written = () => writes.map((w) => w.id)

  it('draws an overlapping board clear without writing anything back', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', 100, 0)])
    await guard()

    expect(framesCollide(rectOf('a'), rectOf('b'), FRAME_GAP)).toBe(false)
    // Nobody authored this overlap locally, so nobody writes it: every client draws the same
    // correction from the same rects, and one write per open session would be pure amplification.
    expect(written()).toEqual([])
  })

  it('leaves a board whose frames already clear each other alone', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', EMPTY_FRAME_SIZE.w + FRAME_GAP, 0)])
    await guard()

    expect(board.getBlock('b')!.position).toEqual({ x: EMPTY_FRAME_SIZE.w + FRAME_GAP, y: 0 })
    expect(written()).toEqual([])
  })

  it('separates a frame that grew into its neighbour, keeping the grown frame in place', async () => {
    // Two empty services a gap apart, then the first one gains a task: it stops rendering the
    // "add the first task" panel and grows to the lane footprint, over its neighbour.
    board.hydrate([frame('a', 0, 0), frame('b', EMPTY_FRAME_SIZE.w + FRAME_GAP, 0)])
    await guard()

    board.upsert({ ...frame('t1', 0, 0), level: 'task', parentId: 'a' })
    await nextTick()

    expect(board.getBlock('a')!.position).toEqual({ x: 0, y: 0 })
    expect(
      framesCollide(
        { ...board.getBlock('a')!.position, ...board.containerSize('a') },
        rectOf('b'),
        FRAME_GAP,
      ),
    ).toBe(false)
    expect(written()).toEqual([])
  })

  it('leaves the frames a drag passes over alone, and settles once the pointer is released', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', 600, 0), frame('c', 1200, 0)])
    await guard()

    // Stand in for a header-handle drag: the dragged frame's position is previewed on every
    // pointer move, and `draggingId` marks it as the one the guard must not move.
    const { draggingId } = useBlockDrag()
    draggingId.value = 'a'
    // Dragged ACROSS `b` on the way to its resting place beside `c`. Bouncing `b` here would
    // persist a rearrangement of a service the user never touched.
    board.previewMove('a', { x: 600, y: 0 })
    await nextTick()
    expect(board.getBlock('b')!.position).toEqual({ x: 600, y: 0 })
    expect(written()).toEqual([])

    board.previewMove('a', { x: 1180, y: 0 })
    await nextTick()
    expect(board.getBlock('b')!.position).toEqual({ x: 600, y: 0 })

    // Release: the drop commits `a` itself, and the guard settles the board around it.
    draggingId.value = null
    await nextTick()

    expect(board.getBlock('a')!.position).toEqual({ x: 1180, y: 0 })
    expect(written()).toEqual(['c'])
    expect(framesCollide(rectOf('a'), rectOf('c'), FRAME_GAP)).toBe(false)
  })

  it('writes through moveBlock alone, so a refused correction can still roll back', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', 600, 0)])
    await guard()

    const { draggingId } = useBlockDrag()
    draggingId.value = 'a'
    board.previewMove('a', { x: 580, y: 0 })
    await nextTick()
    draggingId.value = null
    await nextTick()

    // `moveBlock` snapshots the position it finds and restores it if the write is refused. A
    // `previewMove` ahead of it would hand it the CORRECTION as the value to roll back to,
    // leaving the board showing a position the server never stored.
    expect(writes).toHaveLength(1)
    expect(writes[0]!.storedAtCall).toEqual({ x: 600, y: 0 })
    expect(writes[0]!.to).not.toEqual(writes[0]!.storedAtCall)
  })

  it('writes nothing for a drag that was cancelled rather than dropped', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', 600, 0)])
    await guard()

    const { draggingId } = useBlockDrag()
    draggingId.value = 'a'
    board.previewMove('a', { x: 580, y: 0 })
    await nextTick()
    // A `pointercancel` (or the dragged component unmounting) puts the frame back and commits
    // nothing. The board it leaves behind is already clear, so settling finds no work: the
    // neighbour displacement a cancelled gesture caused must not outlive it.
    board.previewMove('a', { x: 0, y: 0 })
    draggingId.value = null
    await nextTick()

    expect(board.getBlock('b')!.position).toEqual({ x: 600, y: 0 })
    expect(written()).toEqual([])
  })

  it('corrects the view for a read-only viewer but writes nothing', async () => {
    canWriteBoard.value = false
    board.hydrate([frame('a', 0, 0), frame('b', 100, 0)])
    await guard()

    expect(framesCollide(rectOf('a'), rectOf('b'), FRAME_GAP)).toBe(false)
    expect(written()).toEqual([])
  })
})
