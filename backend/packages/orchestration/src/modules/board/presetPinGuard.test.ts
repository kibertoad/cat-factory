import { seedModelPresets, seedRiskPolicies } from '@cat-factory/kernel'
import type { ModelPreset, ModelPresetRepository, RiskPolicyRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { createPresetPinGuard } from './presetPinGuard.js'

/**
 * The pin guard answers one question ("does this id name anything?") for two libraries, and the
 * three ways it can answer are what these cover: the id is there, the id is nowhere, or the
 * library itself is not wired. The BoardService end (which writes consult it, and that a refusal
 * lands before the row) is `BoardService.presetPins.test.ts`.
 */
describe('preset pin guard', () => {
  const WS = 'ws_1'
  const AUTHORED: ModelPreset = {
    id: 'mdp_authored',
    name: 'Authored',
    baseModelId: 'model-x',
    overrides: {},
    isDefault: true,
    createdAt: 0,
  }
  /** A library that HAS been read at least once, so it holds rows rather than the catalog. */
  const seeded = (rows: { id: string }[]) =>
    ({ list: () => Promise.resolve(rows) }) as unknown as ModelPresetRepository &
      RiskPolicyRepository

  const guard = (over: {
    modelPresetRepository?: ModelPresetRepository
    riskPolicyRepository?: RiskPolicyRepository
  }) => createPresetPinGuard(over)

  it('accepts an id the workspace holds, and refuses one it does not', async () => {
    const pins = guard({
      modelPresetRepository: seeded([AUTHORED]),
      riskPolicyRepository: seeded(seedRiskPolicies()),
    })
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, modelPresetId: AUTHORED.id }),
    ).resolves.toBeUndefined()
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, modelPresetId: 'mdp_typo' }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'model_preset_not_found' } })
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, riskPolicyId: 'mp_typo' }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'risk_policy_not_found' } })
  })

  it('never names the other ids, which are a rung above what pinning takes', async () => {
    // Pinning is `write` on `/api/v1` and both lists are `admin`, so a refusal that enumerated the
    // library would hand the lower rung by typo exactly what the higher one gates.
    const pins = guard({ modelPresetRepository: seeded([AUTHORED]) })
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, modelPresetId: 'mdp_typo' }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining(AUTHORED.id) })
  })

  it('treats a never-read library as the built-in catalog it is about to become', async () => {
    // Both libraries materialise lazily on first `list`, so rows alone would refuse a perfectly
    // good built-in on a fresh workspace. Reading the catalog instead keeps this a pure READ:
    // seeding here would be a write performed in order to say no.
    const pins = guard({
      modelPresetRepository: seeded([]),
      riskPolicyRepository: seeded([]),
    })
    await expect(
      pins.assertPinsExist({
        homeWorkspaceId: WS,
        modelPresetId: seedModelPresets()[0]!.id,
        riskPolicyId: seedRiskPolicies()[0]!.id,
      }),
    ).resolves.toBeUndefined()
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, modelPresetId: 'mdp_typo' }),
    ).rejects.toMatchObject({ details: { reason: 'model_preset_not_found' } })
  })

  it('stops consulting the catalog once the workspace has authored its own library', async () => {
    // The converse of the case above, and the one that makes it safe: a built-in an operator
    // DELETED is gone, and resolution would fall back to the default, so accepting its id would
    // be the silent-wrong-preset bug wearing the guard's own clothes.
    const pins = guard({ modelPresetRepository: seeded([AUTHORED]) })
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, modelPresetId: seedModelPresets()[0]!.id }),
    ).rejects.toMatchObject({ details: { reason: 'model_preset_not_found' } })
  })

  it('answers 503 for an unwired library, and only for a caller that pinned one', async () => {
    // "No such policy" is true and useless when the deployment holds none at all: the fix is to
    // wire a module, not to pick another id.
    const pins = guard({})
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, riskPolicyId: 'mp_anything' }),
    ).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'risk_policies_unwired' } })
    await expect(
      pins.assertPinsExist({ homeWorkspaceId: WS, modelPresetId: 'mdp_anything' }),
    ).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'model_presets_unwired' } })
    // A caller that pinned nothing has no dependency on either module being there.
    await expect(pins.assertPinsExist({ homeWorkspaceId: WS })).resolves.toBeUndefined()
  })

  it('reads nothing for the three spellings of "the workspace default"', async () => {
    // The row spells unpinned as absent, null or empty, and all three mean "follow the default",
    // so none of them can miss. A read here would also make every ordinary task creation pay for
    // two queries it has no question for.
    let reads = 0
    const counting = {
      list: () => {
        reads += 1
        return Promise.resolve([])
      },
    } as unknown as ModelPresetRepository
    const pins = guard({ modelPresetRepository: counting })
    for (const value of [undefined, null, ''] as const) {
      await pins.assertPinsExist({ homeWorkspaceId: WS, modelPresetId: value })
    }
    expect(reads).toBe(0)
  })
})
