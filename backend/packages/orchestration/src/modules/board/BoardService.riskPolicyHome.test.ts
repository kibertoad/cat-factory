import {
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  UNATTRIBUTED_BLOCK_EDITOR,
  type BlockEditActor,
  type BlockEditAuthority,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block, RiskPolicy } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

/**
 * WHICH WORKSPACE a merge-preset decision is made in, which is the half
 * `BoardService.riskPolicySelection.test.ts` cannot see: it runs on a board that homes everything
 * it touches, so acting board and home are the same workspace and every wrong base looks right.
 *
 * They come apart on a shared board. A board mounts services homed in other workspaces, and every
 * write on one lands at that home: the row is written there, its `riskPolicyId` resolves against
 * THAT library, and a run on it is admitted through that board under the role the editor holds
 * THERE. Two consequences these cover:
 *
 *  - A cross-home reparent re-decides which policy governs a task while touching neither the id
 *    nor either library, so a member sandboxed by their board's default could drag the task one
 *    service over and start it live with the picker's refusal never consulted.
 *  - The two SELECT doors judge against the home too, not the board the request was addressed to,
 *    or a task created into (or re-pointed inside) a mounted foreign service is judged in a
 *    library it will never resolve against.
 *
 * The mover is judged per workspace throughout: a role is only meaningful in the workspace that
 * granted it, so the acting board's tier answers for neither home.
 */
describe('BoardService: a preset decision is made in the workspace that HOMES the row', () => {
  const SRC = 'ws_src' // homes the task's service, and is the board the drag happens on
  const DEST = 'ws_dest' // homes the destination service, mounted onto SRC's board
  const member: BlockEditActor = { role: 'member', managesPolicy: false }
  const admin: BlockEditActor = { role: 'admin', managesPolicy: true }

  /** An editor holding the same tier in every workspace. */
  const everywhere = (actor: BlockEditActor): BlockEditAuthority => ({
    in: () => Promise.resolve(actor),
  })
  /**
   * An editor whose tier DIFFERS per workspace, which is the normal state of a shared board: the
   * boards a service is mounted onto have their own rosters. A workspace absent from the map is
   * one they hold no access to at all.
   */
  const perWorkspace = (roles: Record<string, BlockEditActor>): BlockEditAuthority => ({
    in: (ws) => Promise.resolve(roles[ws] ?? UNATTRIBUTED_BLOCK_EDITOR),
  })
  const MEMBER = everywhere(member)
  const ADMIN = everywhere(admin)

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
  function build(
    srcBlocks: Block[],
    defaults: Record<string, RiskPolicy | null> = {},
    extra: { destBlocks?: Block[]; presets?: Record<string, RiskPolicy[]> } = {},
  ) {
    const rows: Record<string, Block[]> = {
      [SRC]: [frame('frame_src'), ...srcBlocks],
      [DEST]: [frame('frame_dest'), ...(extra.destBlocks ?? [])],
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
        // ONE read per workspace, whatever the subtree pins: the guard resolves every pick off
        // the library it read whole, which is what keeps a hundred-task module from becoming a
        // hundred point reads. `presetReads` is what the N+1 case below asserts on.
        //
        // No preset id is shared across the two libraries, so an id from SRC is dangling at DEST
        // and falls back to ITS default: the case the guard exists for.
        list: async (ws: string) => {
          presetReads++
          const workspaceDefault = defaultsByWorkspace[ws]
          return [...(workspaceDefault ? [workspaceDefault] : []), ...(extra.presets?.[ws] ?? [])]
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
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(at(rows, DEST, 'task_1')?.parentId).toBe('frame_dest')
  })

  it('judges an INITIATIVE the move carries, not tasks alone', async () => {
    // An initiative block starts its own planning chain, so its pinned preset governs real runs
    // exactly as a task's does. A `level === 'task'` filter saw an empty id list and refused
    // nothing, which is a hole rather than a wrong answer: `BLOCK_LEVEL_RUNS_PIPELINES` is what
    // the guard asks now, so a level becoming runnable cannot go on being exempt silently.
    const { service, rows } = build([
      block('init_1', { level: 'initiative', parentId: 'frame_src' }),
    ])
    await expect(
      service.reparent(SRC, 'init_1', { parentId: 'frame_dest', position: { x: 0, y: 0 } }, MEMBER),
    ).rejects.toMatchObject({ details: { reason: 'relaxes_role_sandbox' } })
    expect(at(rows, DEST, 'init_1')).toBeUndefined()
  })

  it('reads the SOURCE side against the tier held at the source', async () => {
    // A member at SRC (where members are sandboxed) who is an admin at DEST (where nobody is).
    // The sandbox was real for them and the move drops it, so this refuses, and it can only be
    // seen by reading each side against its OWN role: judged with the destination's tier on both
    // sides, SRC's `dryRunRoles: ['member']` says nothing about an admin and the guard finds
    // nothing held. The mirror case (no tier at the destination) pins the other direction.
    const { service, rows } = build([block('task_1', { parentId: 'frame_src' })])
    await expect(
      service.reparent(
        SRC,
        'task_1',
        { parentId: 'frame_dest', position: { x: 1, y: 2 } },
        perWorkspace({ [SRC]: member, [DEST]: { role: 'admin', managesPolicy: false } }),
      ),
    ).rejects.toMatchObject({ details: { reason: 'relaxes_role_sandbox' } })
    expect(at(rows, DEST, 'task_1')).toBeUndefined()
  })

  it('allows the move when the DESTINATION sandboxes the tier the mover holds there', async () => {
    // The mirror of the case above, and the false refusal the acting-board reading also produced:
    // an admin at the source is a member at the destination, where members are sandboxed. Nothing
    // is dropped, because the policy that will govern their runs is the one they land under.
    const { service, rows } = build([block('task_1', { parentId: 'frame_src' })], {
      [DEST]: preset('mp_dest_members_sandboxed', { dryRunRoles: ['member'] }),
    })
    await service.reparent(
      SRC,
      'task_1',
      { parentId: 'frame_dest', position: { x: 1, y: 2 } },
      perWorkspace({ [SRC]: { role: 'admin', managesPolicy: false }, [DEST]: member }),
    )
    expect(at(rows, DEST, 'task_1')?.parentId).toBe('frame_dest')
  })

  it('allows the move when the mover holds no tier at the destination home', async () => {
    // They cannot admit a run in a workspace they are not a member of, so nothing of theirs is
    // dropped by landing the task there. Absent is the strictest reading, not the weakest.
    const { service, rows } = build([block('task_1', { parentId: 'frame_src' })])
    await service.reparent(
      SRC,
      'task_1',
      { parentId: 'frame_dest', position: { x: 1, y: 2 } },
      perWorkspace({ [SRC]: member }),
    )
    expect(at(rows, DEST, 'task_1')?.parentId).toBe('frame_dest')
  })

  it('costs one library read per home however many blocks the subtree carries', async () => {
    // The banned N+1: a point read per pinned preset, with each workspace's default re-read
    // alongside every one of them. Twenty distinct pins across the subtree, still two reads.
    const pinned = Array.from({ length: 20 }, (_, i) =>
      block(`task_${i}`, { parentId: 'mod_1', riskPolicyId: `mp_pinned_${i}` }),
    )
    const { service, presetReads } = build([
      block('mod_1', { level: 'module', parentId: 'frame_src' }),
      ...pinned,
    ])
    await expect(
      service.reparent(SRC, 'mod_1', { parentId: 'frame_dest', position: { x: 0, y: 0 } }, MEMBER),
    ).rejects.toMatchObject({ details: { reason: 'relaxes_role_sandbox' } })
    expect(presetReads()).toBe(2)
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

  it('judges a task CREATED into a mounted foreign service against that service\u2019s home', async () => {
    // `addTask` resolves the container to its home and inserts the row THERE, so judging the
    // pick against the acting board reads the wrong library: both ids resolve to the acting
    // workspace's default, collapse to the same policy, and the guard can never refuse. Here
    // DEST holds the open default the member must not author onto.
    const open = preset('mp_dest_open', { isDefault: false })
    const { service, rows } = build(
      [],
      { [DEST]: preset('mp_dest_sandboxed_default', { dryRunRoles: ['member'] }) },
      { presets: { [DEST]: [open] } },
    )
    await expect(
      service.addTask(
        SRC,
        'frame_dest',
        { title: 'Ship it', riskPolicyId: open.id },
        perWorkspace({ [SRC]: member, [DEST]: member }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'relaxes_role_sandbox' } })
    expect(rows[DEST]?.some((b) => b.level === 'task')).toBe(false)
  })

  it('judges a PATCH on a foreign-homed task against that home, not the acting board', async () => {
    // Same base mismatch at the third door. The task lives at DEST; the patch clears its strict
    // pin, dropping it onto DEST's permissive default. Judged at SRC both ids resolve to SRC's
    // library and the write goes through.
    const strict = preset('mp_dest_strict', { dryRunRoles: ['member'], isDefault: false })
    const { service, rows } = build(
      [],
      {},
      {
        destBlocks: [block('task_1', { parentId: 'frame_dest', riskPolicyId: strict.id })],
        presets: { [DEST]: [strict] },
      },
    )
    await expect(
      service.updateBlock(
        SRC,
        'task_1',
        // Empty is the "workspace default" selection the picker sends, and a real policy choice:
        // it re-points the task at whatever DEST's default happens to be.
        { riskPolicyId: '' },
        perWorkspace({ [SRC]: member, [DEST]: member }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'relaxes_role_sandbox' } })
    expect(at(rows, DEST, 'task_1')?.riskPolicyId).toBe(strict.id)
  })
})
