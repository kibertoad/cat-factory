import { UNATTRIBUTED_BLOCK_EDITOR, type BlockEditActor } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block, RiskPolicy } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

/**
 * A task's merge preset is what decides whether ITS runs are sandboxed for a given role (ADR
 * 0037), so re-pointing the task is a policy decision and not a preference. These cover the
 * BoardService end of that: which of the two writes that can carry a `riskPolicyId` consult the
 * guard, and what they compare against. The rule itself is unit-tested in contracts
 * (`refuseRiskPolicySelection`); what could break here is a door that never asks.
 */
describe('BoardService: merge-preset selection is judged against the editor', () => {
  const WS = 'ws_1'
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
      isDefault: false,
      createdAt: 0,
      ...over,
    }) as RiskPolicy

  /** "Sandboxed" is the workspace default; "open" is the escape a member must not reach. */
  const SANDBOXED = preset('mp_sandboxed', { dryRunRoles: ['member'], isDefault: true })
  const OPEN = preset('mp_open')

  const task = (over: Partial<Block> = {}): Block =>
    ({
      id: 'task_1',
      title: 'Ship it',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: 'frame_1',
      ...over,
    }) as Block

  function build(stored: Block[]) {
    const blocks = [...stored]
    const find = (id: string) => blocks.find((b) => b.id === id)
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        findById: async (id: string) => {
          const block = find(id)
          return block ? { workspaceId: WS, serviceId: null, block } : null
        },
        get: async (_ws: string, id: string) => find(id) ?? null,
        listByWorkspace: async () => blocks,
        insert: async (_ws: string, block: Block) => {
          blocks.push(block)
        },
        update: async (_ws: string, id: string, patch: Partial<Block>) => {
          const i = blocks.findIndex((b) => b.id === id)
          if (i >= 0) blocks[i] = { ...blocks[i], ...patch } as Block
        },
      },
      riskPolicyRepository: {
        get: async (_ws: string, id: string) => [SANDBOXED, OPEN].find((p) => p.id === id) ?? null,
        getDefault: async () => SANDBOXED,
      },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), blocks }
  }

  it('refuses a member re-pointing a sandboxed task at a preset that does not sandbox them', async () => {
    // The escape hatch: `dryRunRoles` is admin-only to EDIT, and this is the other way around it.
    const { service, blocks } = build([task({ riskPolicyId: SANDBOXED.id })])
    await expect(
      service.updateBlock(WS, 'task_1', { riskPolicyId: OPEN.id }, MEMBER),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'relaxes_role_sandbox' } })
    // Refused BEFORE the write, so the task is still governed by the policy it was under.
    expect(blocks[0]?.riskPolicyId).toBe(SANDBOXED.id)
  })

  it('refuses the same member CREATING a task on that preset, judged against the workspace default', async () => {
    // Creation is the same decision: a task that picks nothing is governed by the default, so
    // authoring straight onto a permissive preset moves off exactly the policy a swap would.
    const { service, blocks } = build([task({ id: 'frame_1', level: 'frame', parentId: null })])
    await expect(
      service.addTask(WS, 'frame_1', { title: 'Ship it', riskPolicyId: OPEN.id }, MEMBER),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'relaxes_role_sandbox' } })
    expect(blocks).toHaveLength(1) // nothing was created
  })

  it('lets the same member ADOPT the sandbox, and pick a preset again once already on the open one', async () => {
    // Narrow-only cuts one way, and the guard compares against what the task is ACTUALLY under,
    // never against the strictest preset in the library.
    const { service } = build([task({ riskPolicyId: OPEN.id })])
    await expect(
      service.updateBlock(WS, 'task_1', { riskPolicyId: SANDBOXED.id }, MEMBER),
    ).resolves.toMatchObject({ riskPolicyId: SANDBOXED.id })
  })

  it('lets an admin make the swap the member could not', async () => {
    const { service } = build([task({ riskPolicyId: SANDBOXED.id })])
    await expect(
      service.updateBlock(WS, 'task_1', { riskPolicyId: OPEN.id }, ADMIN),
    ).resolves.toMatchObject({ riskPolicyId: OPEN.id })
  })

  it('leaves a patch that does not name the preset alone', async () => {
    // The guard reads the preset library, so a title edit must not pay for it, and above all
    // must not be refused on a task someone else pointed at an open preset.
    const { service } = build([task({ riskPolicyId: OPEN.id })])
    await expect(
      service.updateBlock(WS, 'task_1', { title: 'Renamed' }, MEMBER),
    ).resolves.toMatchObject({ title: 'Renamed' })
  })

  it('never refuses an editor with no workspace tier', async () => {
    // A board scan, an API key and auth-disabled dev all reach here with no role: there is no
    // tier whose restrictions could be dropped, which is the same reading an unattributed RUN gets.
    const { service } = build([task({ riskPolicyId: SANDBOXED.id })])
    await expect(
      service.updateBlock(WS, 'task_1', { riskPolicyId: OPEN.id }, UNATTRIBUTED_BLOCK_EDITOR),
    ).resolves.toMatchObject({ riskPolicyId: OPEN.id })
  })
})
