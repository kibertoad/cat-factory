import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameOverlapGuard } from '~/composables/useFrameOverlapGuard'
import { EMPTY_FRAME_SIZE, FRAME_GAP, framesCollide } from '~/utils/framePlacement'

/**
 * The guard is the wiring around `resolveFrameOverlaps` (whose geometry is pinned in
 * `framePlacement.spec.ts`): what it watches, what it corrects locally, and when it writes the
 * correction back. The last of those is the part worth a test: an eager write during a drag is
 * exactly the race `previewMove` exists to avoid.
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

describe('useFrameOverlapGuard', () => {
  let scope: EffectScope
  let board: ReturnType<typeof useBoardStore>
  let moveBlock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    canWriteBoard.value = true
    vi.stubGlobal('useUiStore', () => ({ zoom: 1 }))
    vi.stubGlobal('useWorkspaceAccess', () => ({ canWriteBoard }))
    board = useBoardStore()
    moveBlock = vi.fn()
    board.moveBlock = moveBlock as unknown as typeof board.moveBlock
    // The composables under test reach the store through Nuxt's auto-import, which plain Vitest
    // does not provide; hand them the same instance the assertions read.
    vi.stubGlobal('useBoardStore', () => board)
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })

  /** Start the guard over the frames the board currently holds and let its first pass run. */
  async function guard() {
    scope.run(() => useFrameOverlapGuard())
    await nextTick()
  }

  const rectOf = (id: string) => ({ ...board.getBlock(id)!.position, ...EMPTY_FRAME_SIZE })

  it('bounces overlapping frames apart and writes the correction back', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', 100, 0)])
    await guard()

    expect(framesCollide(rectOf('a'), rectOf('b'), FRAME_GAP)).toBe(false)
    // Corrected on screen immediately; the write is coalesced behind the debounce.
    expect(moveBlock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(moveBlock).toHaveBeenCalledTimes(1)
    expect(moveBlock).toHaveBeenCalledWith('b', board.getBlock('b')!.position)
  })

  it('leaves a board whose frames already clear each other alone', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', EMPTY_FRAME_SIZE.w + FRAME_GAP, 0)])
    await guard()
    await vi.advanceTimersByTimeAsync(500)

    expect(board.getBlock('b')!.position).toEqual({ x: EMPTY_FRAME_SIZE.w + FRAME_GAP, y: 0 })
    expect(moveBlock).not.toHaveBeenCalled()
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
  })

  it('holds the write while a drag is running, then commits it once the pointer is released', async () => {
    board.hydrate([frame('a', 0, 0), frame('b', 600, 0)])
    await guard()

    // Stand in for a header-handle drag: the dragged frame's position is previewed on every
    // pointer move, and `draggingId` marks it as the one the guard must not move.
    const { draggingId } = useBlockDrag()
    draggingId.value = 'a'
    board.previewMove('a', { x: 500, y: 0 })
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)

    // The neighbour has already moved aside on screen; nothing is written mid-drag, and the
    // frame under the pointer stays exactly where the user put it.
    expect(board.getBlock('a')!.position).toEqual({ x: 500, y: 0 })
    expect(framesCollide(rectOf('a'), rectOf('b'), FRAME_GAP)).toBe(false)
    expect(moveBlock).not.toHaveBeenCalled()

    draggingId.value = null
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    expect(moveBlock.mock.calls.map(([id]) => id)).toEqual(['b'])
  })

  it('corrects the view for a read-only viewer but writes nothing', async () => {
    canWriteBoard.value = false
    board.hydrate([frame('a', 0, 0), frame('b', 100, 0)])
    await guard()
    await vi.advanceTimersByTimeAsync(500)

    expect(framesCollide(rectOf('a'), rectOf('b'), FRAME_GAP)).toBe(false)
    expect(moveBlock).not.toHaveBeenCalled()
  })
})
