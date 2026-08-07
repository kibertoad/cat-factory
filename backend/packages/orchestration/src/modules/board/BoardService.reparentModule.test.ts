import { describe, expect, it } from 'vitest'
import type { Block, BlockPatch } from '@cat-factory/kernel'
import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

/**
 * A task states its module twice — the block it is parented to, and the `moduleName` it declares —
 * and a move has to write both. The declared name exists because the engine only materialises the
 * module BLOCK on merge, so the board falls back to it for a task whose module has no block yet;
 * left un-restamped on a move, that fallback files a card straight back under the module it was
 * just dragged out of, and the gesture reads as broken.
 *
 * The rule is the same one `type` already followed: both are facts about the container a task now
 * sits in, not about the task.
 */
describe('BoardService.reparent re-stamps the declared module', () => {
  const WS = 'ws_1'

  function block(id: string, level: Block['level'], extra: Partial<Block> = {}): Block {
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
      level,
      parentId: level === 'frame' ? null : 'frame_svc',
      ...extra,
    }
  }

  /** The board: one service frame with two modules, plus whatever task the case needs. */
  function build(task: Block) {
    const byId = new Map<string, Block>(
      [
        block('frame_svc', 'frame'),
        block('frame_other', 'frame'),
        block('mod_sessions', 'module', { title: 'Sessions' }),
        block('mod_billing', 'module', { title: 'Billing' }),
        task,
      ].map((b) => [b.id, b]),
    )
    const patches: BlockPatch[] = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
        listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
        resolve: async (id: string) => {
          const b = byId.get(id)
          return b ? { workspaceId: WS, block: b, serviceId: null } : null
        },
        update: async (_ws: string, id: string, patch: BlockPatch) => {
          patches.push(patch)
          Object.assign(byId.get(id)!, patch)
        },
      },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
      executionEventPublisher: {
        async executionChanged() {},
        async boardChanged() {},
        async bootstrapChanged() {},
        async notificationChanged() {},
        async llmCallObserved() {},
      },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), patches }
  }

  const at = { position: { x: 0, y: 0 } }

  it('clears the declared module when a task is dragged out to its service frame', async () => {
    // The case the board exposed: the parent becomes the frame, and without this the card's own
    // `moduleName` still names the module, so it re-groups under the module it just left.
    const task = block('task_1', 'task', { parentId: 'mod_sessions', moduleName: 'Sessions' })
    const { service, patches } = build(task)

    await service.reparent(WS, 'task_1', { parentId: 'frame_svc', ...at }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY)

    expect(patches.at(-1)).toMatchObject({ parentId: 'frame_svc', moduleName: '' })
  })

  it('clears a module a task only DECLARED, when it moves to a frame that does not own it', async () => {
    // A task can name a module the engine has not created a block for yet. That name belongs to
    // the service that owns the module, so carrying it across would invent a module in the
    // destination — the same wrong answer, reached without ever being parented to a module.
    const task = block('task_1', 'task', { parentId: 'frame_svc', moduleName: 'Not yet created' })
    const { service, patches } = build(task)

    await service.reparent(WS, 'task_1', { parentId: 'mod_billing', ...at }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY)

    expect(patches.at(-1)).toMatchObject({ parentId: 'mod_billing', moduleName: 'Billing' })
  })

  it('writes no module key at all when a module-less task moves between module-less containers', async () => {
    // Nothing to restate, and a patch rewriting a column to the value it already holds is a write
    // every mounting board's fan-out carries for no change. Same reasoning as the `type` re-stamp
    // beside it, which is likewise conditional.
    const task = block('task_1', 'task', { parentId: 'frame_svc' })
    const { service, patches } = build(task)

    await service.reparent(WS, 'task_1', { parentId: 'frame_other', ...at }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY)

    expect(patches.at(-1)).not.toHaveProperty('moduleName')
  })

  it('carries a task in and back out of a module, one round trip', async () => {
    const task = block('task_1', 'task', { parentId: 'frame_svc' })
    const { service, patches } = build(task)

    await service.reparent(WS, 'task_1', { parentId: 'mod_sessions', ...at }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY)
    await service.reparent(WS, 'task_1', { parentId: 'frame_svc', ...at }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY)

    expect(patches[0]).toMatchObject({ moduleName: 'Sessions' })
    // Back out: the name goes with it, and lands as the empty string the store maps to NULL.
    expect(patches[1]).toMatchObject({ moduleName: '' })
  })
})
