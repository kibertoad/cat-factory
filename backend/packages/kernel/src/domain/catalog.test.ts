import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_PRESET,
  DEFAULT_MODEL_PRESETS,
  DEFAULT_MODEL_PRESET_ID,
  RISK_POLICY_SEEDS,
  modelForKindFromPreset,
  presetOverrideForKind,
  riskPolicyFromSeed,
  riskPolicySeedRows,
  seedModelPresets,
  seedRiskPolicies,
  type ModelPresetSeed,
} from './catalog.js'

// The catalog's DATA is data; what is worth pinning is the small amount of logic around it: the
// seed copies two writers both depend on being identical, the `createdAt` stamping that decides
// the order the library reads back in, and the two-answer model resolution a judge's own model
// pin is layered on top of.

describe('seedRiskPolicies', () => {
  it('hands out FRESH copies, so a caller stamping ids/timestamps cannot edit the catalog', () => {
    const first = seedRiskPolicies()
    first[0]!.name = 'edited'
    expect(seedRiskPolicies()[0]?.name).toBe(RISK_POLICY_SEEDS[0]?.name)
    expect(seedRiskPolicies()[0]).not.toBe(RISK_POLICY_SEEDS[0])
  })

  it('ships the whole catalog, with exactly one default', () => {
    const seeds = seedRiskPolicies()
    expect(seeds).toHaveLength(RISK_POLICY_SEEDS.length)
    expect(seeds.filter((s) => s.isDefault)).toHaveLength(1)
    expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length)
  })
})

describe('riskPolicyFromSeed', () => {
  it('carries every field of the seed onto the row, plus the stamped createdAt', () => {
    // Two writers produce these bytes (board creation seeds the library, `reseed` restores a
    // built-in afterwards). A field this drops is a field a reseed silently rewrites to the
    // schema default on a workspace that had been seeded correctly.
    const seed = RISK_POLICY_SEEDS[0]!
    const row = riskPolicyFromSeed(seed, 4_242)
    expect(row).toEqual({ ...seed, createdAt: 4_242 })
    // Derived from the seed itself rather than a hand-written field list, so a field added to
    // `RiskPolicySeed` is covered the moment it exists.
    for (const key of Object.keys(seed) as (keyof typeof seed)[]) {
      expect(row[key], key).toEqual(seed[key])
    }
  })

  it('stamps the createdAt it is GIVEN, for every seed in the catalog', () => {
    for (const seed of seedRiskPolicies()) {
      expect(riskPolicyFromSeed(seed, 0).createdAt, seed.id).toBe(0)
      expect(riskPolicyFromSeed(seed, 9).createdAt, seed.id).toBe(9)
    }
  })
})

describe('riskPolicySeedRows', () => {
  it('stamps createdAt by CATALOG ORDER, so the library reads back in the declared order', () => {
    // `list` orders by `createdAt`; identical stamps would leave the order down to whichever
    // insert happened to commit first.
    const rows = riskPolicySeedRows(1_000)
    expect(rows.map((r) => r.createdAt)).toEqual(rows.map((_, i) => 1_000 + i))
    expect(rows.map((r) => r.id)).toEqual(RISK_POLICY_SEEDS.map((s) => s.id))
    expect(new Set(rows.map((r) => r.createdAt)).size).toBe(rows.length)
  })

  it('produces rows a facade can insert, one per catalog entry', () => {
    expect(riskPolicySeedRows(0)).toHaveLength(RISK_POLICY_SEEDS.length)
  })
})

describe('seedModelPresets', () => {
  it('copies the overrides bag too, not just the preset object', () => {
    // A shallow copy would leave every seeded workspace sharing ONE overrides object, so a
    // per-workspace override would appear on every board seeded in the same process.
    const seeded = seedModelPresets()
    seeded[0]!.overrides['coder'] = 'smuggled'
    expect(seedModelPresets()[0]?.overrides).toEqual({})
    expect(DEFAULT_MODEL_PRESETS[0]?.overrides).toEqual({})
  })

  it('ships every built-in preset with a distinct id', () => {
    const seeded = seedModelPresets()
    expect(seeded.map((p) => p.id)).toEqual(DEFAULT_MODEL_PRESETS.map((p) => p.id))
    expect(new Set(seeded.map((p) => p.id)).size).toBe(seeded.length)
  })

  it('names a fallback default preset that is actually in the catalog', () => {
    expect(DEFAULT_MODEL_PRESET.id).toBe(DEFAULT_MODEL_PRESET_ID)
    expect(DEFAULT_MODEL_PRESETS.map((p) => p.id)).toContain(DEFAULT_MODEL_PRESET_ID)
  })
})

describe('modelForKindFromPreset / presetOverrideForKind', () => {
  const preset: ModelPresetSeed = {
    id: 'mdp_x',
    name: 'X',
    baseModelId: 'base',
    overrides: { coder: 'pinned' },
    version: 1,
  }

  it('prefers the per-kind override over the preset’s base model', () => {
    expect(modelForKindFromPreset(preset, 'coder')).toBe('pinned')
  })

  it('falls back to the base model for a kind the preset says nothing about', () => {
    expect(modelForKindFromPreset(preset, 'tester')).toBe('base')
  })

  it('falls back to the catalog default when NO preset resolved', () => {
    // A workspace whose library is not yet materialised still has to dispatch on something
    // runnable, which is what the catalog default is for.
    for (const none of [null, undefined] as const) {
      expect(modelForKindFromPreset(none, 'coder')).toBe(DEFAULT_MODEL_PRESET.baseModelId)
      expect(presetOverrideForKind(none, 'coder')).toBeUndefined()
    }
  })

  it('keeps "the preset NAMES this kind" a SEPARATE answer from "the base applies"', () => {
    // The distinction is load-bearing: a judge registration pins the model its rubric was
    // authored for, and that pin sits ABOVE a preset's base (a blanket statement about every
    // kind) but BELOW an override that names the judge's kind. Collapsing the two answers makes
    // such a pin unreachable, because every preset would look like it named every kind.
    expect(presetOverrideForKind(preset, 'coder')).toBe('pinned')
    expect(presetOverrideForKind(preset, 'tester')).toBeUndefined()
    expect(modelForKindFromPreset(preset, 'tester')).toBe('base')
  })

  it('reads the override off the preset it was HANDED, not off the catalog default', () => {
    // The `?? DEFAULT_MODEL_PRESET` fallback applies only when no preset resolved; a preset that
    // resolved but says nothing about the kind must still answer from its OWN base model.
    const empty: ModelPresetSeed = {
      id: 'mdp_y',
      name: 'Y',
      baseModelId: 'only-mine',
      overrides: {},
      version: 1,
    }
    expect(modelForKindFromPreset(empty, 'coder')).toBe('only-mine')
    expect(modelForKindFromPreset(empty, 'coder')).not.toBe(DEFAULT_MODEL_PRESET.baseModelId)
  })
})
