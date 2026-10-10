import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// `setDependency`, the EXPLICIT form of a dependency edge, beside the board canvas's `toggleDependency`.
//
// The two doors want different things and neither is the other's read-modify-write. A human
// clicking an edge they can see means "flip it". An API caller DECLARES: a provisioning integration
// re-running its own setup must converge, and a toggle would invert every edge it declared last
// time, silently, since both calls succeed and the graph it asked for is the one it does not get.
//
// The convergence cases below are the whole reason the method exists, so they are asserted here
// rather than only through the public surface: a wire test would show the endpoint answering 200
// twice, which is exactly what the buggy version does too.
describe('BoardService — explicit dependency edges', () => {
  const WS = 'ws_1'

  function block(id: string, over: Partial<Block> = {}): Block {
    return {
      id,
      title: id,
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: 'f1',
      ...over,
    }
  }

  /** A BoardService over in-memory, workspace-scoped blocks, with a recording `update`. */
  function build(blocks: Block[]) {
    const blocksMap = new Map(blocks.map((b) => [b.id, b]))
    const writes: { id: string; dependsOn: string[] }[] = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }), accountOf: async () => 'acc_1' },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (blocksMap.get(id) ?? null) : null),
        listByWorkspace: async (ws: string) => (ws === WS ? [...blocksMap.values()] : []),
        update: async (_ws: string, id: string, patch: { dependsOn?: string[] }) => {
          const current = blocksMap.get(id)
          if (!current || !patch.dependsOn) return
          writes.push({ id, dependsOn: [...patch.dependsOn] })
          blocksMap.set(id, { ...current, dependsOn: patch.dependsOn })
        },
      },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), writes }
  }

  const seed = () => [block('f1', { level: 'frame', parentId: null }), block('t1'), block('t2')]

  it('adds an edge, and a repeated add CONVERGES rather than dropping it', async () => {
    const { service, writes } = build(seed())
    expect((await service.setDependency(WS, 't1', 't2', true)).dependsOn).toEqual(['t2'])
    expect((await service.setDependency(WS, 't1', 't2', true)).dependsOn).toEqual(['t2'])
    // The second call must not even WRITE: an edge already where the caller asked for it is not a
    // change, and re-writing it would fan a board event out for one nobody made.
    expect(writes).toEqual([{ id: 't1', dependsOn: ['t2'] }])
  })

  it('removes an edge, and a repeated remove converges too', async () => {
    const { service, writes } = build(seed())
    await service.setDependency(WS, 't1', 't2', true)
    expect((await service.setDependency(WS, 't1', 't2', false)).dependsOn).toEqual([])
    expect((await service.setDependency(WS, 't1', 't2', false)).dependsOn).toEqual([])
    expect(writes).toEqual([
      { id: 't1', dependsOn: ['t2'] },
      { id: 't1', dependsOn: [] },
    ])
  })

  it('leaves the canvas TOGGLE flipping, which is what a human clicking an edge means', async () => {
    // The other side of the split: `toggleDependency` must keep its own semantics, or the board
    // gesture stops being able to remove an edge at all.
    const { service } = build(seed())
    expect((await service.toggleDependency(WS, 't1', 't2')).dependsOn).toEqual(['t2'])
    expect((await service.toggleDependency(WS, 't1', 't2')).dependsOn).toEqual([])
  })

  it('drops an edge whose BLOCKER no longer resolves, so a task cannot be gated forever', async () => {
    // `pruneDanglingEdges` runs against the deleted block's HOME workspace, so a blocker deleted on
    // the board that homes it leaves the edge behind on a task homed elsewhere. Resolving the
    // source on the remove path made that edge permanently unremovable — and the engine's start
    // gate waits for a blocker that can never reach `done`, so the task never runs again.
    const { service, writes } = build(seed())
    await service.setDependency(WS, 't1', 't2', true)
    const { service: afterDelete } = build([
      block('f1', { level: 'frame', parentId: null }),
      block('t1', { dependsOn: ['t_gone'] }),
    ])
    expect((await afterDelete.setDependency(WS, 't1', 't_gone', false)).dependsOn).toEqual([])
    // The ADD keeps requiring it: an edge may only point at a resolvable task, and that rule is
    // about what an edge points AT rather than about the target's own row.
    await expect(service.setDependency(WS, 't1', 't_gone', true)).rejects.toThrow()
    expect(writes).toEqual([{ id: 't1', dependsOn: ['t2'] }])
  })

  it('refuses a cycle, an edge onto a non-task, and a self-edge, whichever form asks', async () => {
    // These guards belong to the write path both forms share, so both must inherit them: a cycle
    // would wedge the engine's start gate and the auto-start against each other forever, and an
    // edge onto a frame can never be satisfied because only a task ever reaches `done`.
    const { service } = build(seed())
    await service.setDependency(WS, 't1', 't2', true)
    await expect(service.setDependency(WS, 't2', 't1', true)).rejects.toThrow(/cycle/i)
    await expect(service.setDependency(WS, 't1', 'f1', true)).rejects.toThrow(/tasks/i)
    await expect(service.setDependency(WS, 't1', 't1', true)).rejects.toThrow(/itself/i)
  })
})
