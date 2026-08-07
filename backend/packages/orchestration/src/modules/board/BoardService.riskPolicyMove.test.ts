import { UNATTRIBUTED_BLOCK_EDITOR, type BlockEditActor } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block, RiskPolicy } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

/**
 * The other way a task changes merge policy, and the one `BoardService.riskPolicySelection.test.ts`
 * cannot see: not the id, the HOME.
 *
 * `riskPolicyId` resolves against the workspace that homes the task, so a cross-home reparent
 * (dragging a task or a module into a service homed on another workspace, both mounted on this
 * board) re-decides which policy governs its runs while touching neither the id nor either preset
 * library. A member sandboxed by their board's default could therefore drag the task one service
 * over and start it live, with the picker's refusal never consulted.
 *
 * Same rule, same reasons, different door: the guard compares the policy in force at the SOURCE
 * home against the one in force at the DESTINATION home, for every task in the moved subtree.
 */
describe('BoardService: a cross-home move is judged against the mover', () => {
  const SRC = 'ws_src' // homes the task's service, and is the board the drag happens on
  const DEST = 'ws_dest' // homes the destination service, mounted onto SRC's board
  const MEMBER: BlockEditActor = { role: 'member', managesPolicy: false }
  const ADMIN: BlockEditActor = { role: 'admin', managesPolicy: true }

  const preset = (id: string, over: Partial<RiskPolicy> = {}): RiskPolicy =>
    ({
      id,
      name: id,
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      maxTesterQualityIterations: 3,
      releaseWatchWindowMinutes: 30,
      releaseMaxAttempts: 1,
      humanReviewGraceMinutes: 10,
      judgeMinScore: 0.7,
      judgeMaxBounces: 1,
      autoMergeEnabled: true,
      classRules: {},
      classRulesByRole: {},
      dryRunRoles: [],
      isDefault: true,
      createdAt: 0,
      ...over,
    }) as RiskPolicy

  /** The source board sandboxes members by default; the destination board does not. */
  const SRC_DEFAULT = preset('mp_src_default', { dryRunRoles: ['member'] })
  const DEST_DEFAULT = preset('mp_dest_default')

  const block = (id: string, over: Partial<Block> = {}): Block =>
    ({
      id,
      title: id,
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: null,
      ...over,
    }) as Block

  const frame = (id: string) => block(id, { level: 'frame', parentId: null, status: 'ready' })

  /**
   * Two physical homes, sharing wired: SRC holds `frame_src` and whatever is passed in, DEST holds
   * `frame_dest`, and SRC's board mounts DEST's service so the drag resolves both ends.
   *
   * `presets` counts the preset reads, so a test can assert the guard did not run at all rather
   * than only that it did not refuse: a same-home move must cost nothing.
   */
  function build(srcBlocks: Block[], defaults: Record<string, RiskPolicy | null> = {}) {
    const rows: Record<string, Block[]> = {
      [SRC]: [frame('frame_src'), ...srcBlocks],
      [DEST]: [frame('frame_dest')],
    }
    const defaultsByWorkspace: Record<string, RiskPolicy | null> = {
      [SRC]: SRC_DEFAULT,
      [DEST]: DEST_DEFAULT,
      ...defaults,
    }
    let presetReads = 0
    const find = (ws: string, id: string) => rows[ws]?.find((b) => b.id === id) ?? null

    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => find(ws, id),
        findById: async (id: string) => {
          for (const [ws, blocks] of Object.entries(rows)) {
            const found = blocks.find((b) => b.id === id)
            if (found) return { workspaceId: ws, serviceId: `svc_${ws}`, block: found }
          }
          return null
        },
        listByWorkspace: async (ws: string) => rows[ws] ?? [],
        insert: async (ws: string, b: Block) => {
          rows[ws] = [...(rows[ws] ?? []), b]
        },
        update: async (ws: string, id: string, patch: Partial<Block>) => {
          const list = rows[ws] ?? []
          const i = list.findIndex((b) => b.id === id)
          if (i >= 0) list[i] = { ...list[i], ...patch } as Block
        },
        deleteMany: async (ws: string, ids: string[]) => {
          rows[ws] = (rows[ws] ?? []).filter((b) => !ids.includes(b.id))
        },
        setService: async () => {},
      },
      executionRepository: {
        getByBlock: async () => null,
        deleteByBlock: async () => {},
        upsert: async () => {},
      },
      serviceRepository: { getByFrameBlock: async (id: string) => ({ id: `svc_${id}` }) },
      workspaceMountRepository: {
        // SRC's board mounts DEST's service, which is what makes `frame_dest` reachable from it.
        get: async (ws: string, serviceId: string) =>
          ws === SRC && serviceId === `svc_${DEST}` ? { workspaceId: ws, serviceId } : null,
        listWorkspaceIdsMountingBlock: async () => [],
      },
      riskPolicyRepository: {
        get: async () => {
          presetReads++
          // No preset id is shared across the two libraries: an id from SRC is dangling at DEST,
          // which is the fallback-to-the-destination-default case the guard exists for.
          return null
        },
        getDefault: async (ws: string) => {
          presetReads++
          return defaultsByWorkspace[ws] ?? null
        },
      },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies

    return { service: new BoardService(deps), rows, presetReads: () => presetReads }
  }

  const at = (rows: Record<string, Block[]>, ws: string, id: string) =>
    rows[ws]?.find((b) => b.id === id)

  it('refuses a member dragging a sandboxed task into a service homed where they are not', async () => {
    const { service, rows } = build([block('task_1', { parentId: 'frame_src' })])
    await expect(
      service.reparent(SRC, 'task_1', { parentId: 'frame_dest', position: { x: 1, y: 2 } }, MEMBER),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'relaxes_role_sandbox' } })
    // Refused BEFORE the migration: the row is still at its old home, under its old parent.
    expect(at(rows, SRC, 'task_1')?.parentId).toBe('frame_src')
    expect(at(rows, DEST, 'task_1')).toBeUndefined()
  })

  it('judges every task the move carries, not just the block that was dragged', async () => {
    // A module is dragged; the sandbox belongs to the task inside it. Reading the dragged block
    // alone would see a module, which pins no preset and could never refuse anything.
    const { service, rows } = build([
      block('mod_1', { level: 'module', parentId: 'frame_src' }),
      block('task_1', { parentId: 'mod_1' }),
    ])
    await expect(
      service.reparent(SRC, 'mod_1', { parentId: 'frame_dest', position: { x: 0, y: 0 } }, MEMBER),
    ).rejects.toMatchObject({ details: { reason: 'relaxes_role_sandbox' } })
    expect(at(rows, DEST, 'task_1')).toBeUndefined()
  })

  it('allows the move when the destination sandboxes the member just as much', async () => {
    // Narrow-only cuts one way: what is refused is DROPPING a restriction, never moving under one.
    const { service, rows } = build([block('task_1', { parentId: 'frame_src' })], {
      [DEST]: preset('mp_dest_strict', { dryRunRoles: ['member'] }),
    })
    await service.reparent(
      SRC,
      'task_1',
      { parentId: 'frame_dest', position: { x: 1, y: 2 } },
      MEMBER,
    )
    expect(at(rows, DEST, 'task_1')?.parentId).toBe('frame_dest')
    expect(at(rows, SRC, 'task_1')).toBeUndefined()
  })

  it('lets an admin make the move the member could not', async () => {
    const { service, rows } = build([block('task_1', { parentId: 'frame_src' })])
    await service.reparent(
      SRC,
      'task_1',
      { parentId: 'frame_dest', position: { x: 1, y: 2 } },
      ADMIN,
    )
    expect(at(rows, DEST, 'task_1')?.parentId).toBe('frame_dest')
  })

  it('never refuses an editor with no workspace tier', async () => {
    // The post-merge module materialisation reaches reparent with no session behind it; there is
    // no role whose restrictions could be dropped, the same reading every other door gives.
    const { service, rows } = build([block('task_1', { parentId: 'frame_src' })])
    await service.reparent(
      SRC,
      'task_1',
      { parentId: 'frame_dest', position: { x: 1, y: 2 } },
      UNATTRIBUTED_BLOCK_EDITOR,
    )
    expect(at(rows, DEST, 'task_1')?.parentId).toBe('frame_dest')
  })

  it('reads no preset at all for a move that keeps the home', async () => {
    // The overwhelmingly common drag, and the one that decides nothing: same workspace, same
    // library, same ids. Asserting the READ rather than the outcome is what pins that, since a
    // same-home comparison would resolve identical policies and pass either way.
    const { service, rows, presetReads } = build([
      block('mod_1', { level: 'module', parentId: 'frame_src' }),
      block('task_1', { parentId: 'frame_src' }),
    ])
    await service.reparent(SRC, 'task_1', { parentId: 'mod_1', position: { x: 1, y: 2 } }, MEMBER)
    expect(at(rows, SRC, 'task_1')?.parentId).toBe('mod_1')
    expect(presetReads()).toBe(0)
  })
})
