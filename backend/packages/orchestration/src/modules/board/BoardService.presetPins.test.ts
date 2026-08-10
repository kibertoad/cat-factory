import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import type { Block, ModelPreset, RiskPolicy } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

/**
 * A dangling `modelPresetId` / `riskPolicyId` resolves to the workspace DEFAULT at run time rather
 * than failing, so an unchecked typo is a run that succeeds while being about something else. The
 * rule is unit-tested in `presetPinGuard.test.ts`; what this covers is the part only the service
 * can answer: that BOTH writes that can carry a pin consult it, and that a refusal lands before
 * the row does.
 *
 * The reason these live on the SERVICE at all is the list of doors: the SPA, the internal API, the
 * public API, tracker intake, an initiative spawn and blueprint reconciliation all reach `addTask`
 * and `updateBlock`. A check at one of them leaves the other five falling back silently.
 */
describe('BoardService: a pinned preset must name something', () => {
  const WS = 'ws_1'
  const PRESET = { id: 'mdp_real', name: 'Real', baseModelId: 'm', overrides: {} } as ModelPreset
  const POLICY = { id: 'mp_real', name: 'Real' } as RiskPolicy

  const block = (over: Partial<Block> = {}): Block =>
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

  function build(stored: Block[], wired = true) {
    const blocks = [...stored]
    const find = (id: string) => blocks.find((b) => b.id === id)
    const library = { list: () => Promise.resolve([PRESET]) }
    const policies = { list: () => Promise.resolve([POLICY]) }
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        findById: async (id: string) => {
          const found = find(id)
          return found ? { workspaceId: WS, serviceId: null, block: found } : null
        },
        get: async (_ws: string, id: string) => find(id) ?? null,
        listByWorkspace: async () => blocks,
        insert: async (_ws: string, added: Block) => {
          blocks.push(added)
        },
        update: async (_ws: string, id: string, patch: Partial<Block>) => {
          const i = blocks.findIndex((b) => b.id === id)
          if (i >= 0) blocks[i] = { ...blocks[i], ...patch } as Block
        },
      },
      ...(wired ? { modelPresetRepository: library, riskPolicyRepository: policies } : {}),
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), blocks }
  }

  const FRAME = block({ id: 'frame_1', level: 'frame', parentId: null })

  it('creates a task on a real pin, and refuses one naming nothing', async () => {
    const { service, blocks } = build([FRAME])
    await expect(
      service.addTask(
        WS,
        'frame_1',
        { title: 'Pinned', modelPresetId: PRESET.id, riskPolicyId: POLICY.id },
        UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
      ),
    ).resolves.toMatchObject({ modelPresetId: PRESET.id, riskPolicyId: POLICY.id })

    await expect(
      service.addTask(
        WS,
        'frame_1',
        { title: 'Typo', modelPresetId: 'mdp_nope' },
        UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
      ),
    ).rejects.toMatchObject({ details: { reason: 'model_preset_not_found' } })
    // Before the write: a task created and then reported as an error is invisible to the caller
    // and permanent on the board.
    expect(blocks.filter((b) => b.title === 'Typo')).toHaveLength(0)
  })

  it('refuses a patch that re-points at nothing, leaving the previous pin in force', async () => {
    const { service, blocks } = build([FRAME, block({ riskPolicyId: POLICY.id })])
    await expect(
      service.updateBlock(WS, 'task_1', { riskPolicyId: 'mp_nope' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
    ).rejects.toMatchObject({ details: { reason: 'risk_policy_not_found' } })
    expect(blocks[1]?.riskPolicyId).toBe(POLICY.id)
  })

  it('leaves a write that pins nothing alone', async () => {
    // Every ordinary task creation goes through here, and none of them has a question to ask.
    const { service } = build([FRAME])
    await expect(
      service.addTask(WS, 'frame_1', { title: 'Plain' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
    ).resolves.toMatchObject({ title: 'Plain' })
    await expect(
      service.updateBlock(WS, 'frame_1', { title: 'Renamed' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
    ).resolves.toMatchObject({ title: 'Renamed' })
  })

  it('answers unavailable, not not-found, when the deployment wired no library', async () => {
    const { service } = build([FRAME], false)
    await expect(
      service.addTask(
        WS,
        'frame_1',
        { title: 'Pinned', modelPresetId: 'mdp_real' },
        UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'model_presets_unwired' } })
  })
})
