import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_PRESET,
  DEFAULT_MODEL_PRESETS,
  DEFAULT_MODEL_PRESET_ID,
  RISK_POLICY_SEEDS,
  UNATTENDED_RISK_POLICY_ID,
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

  it('ships the whole catalog, with exactly one default PER SCOPE', () => {
    const seeds = seedRiskPolicies()
    expect(seeds).toHaveLength(RISK_POLICY_SEEDS.length)
    expect(seeds.filter((s) => s.isDefault)).toHaveLength(1)
    // The second scope, asserted separately: a workspace resolves this one for every run nothing
    // is watching, and a catalog that seeded none would hand those runs `FALLBACK_RISK_POLICY`,
    // which auto-merges nothing. Two defaults with one assertion between them would let that
    // through as long as the totals still came to one.
    expect(seeds.filter((s) => s.isUnattendedDefault)).toHaveLength(1)
    expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length)
  })

  it('grants the unattended licence to exactly the policy that is the unattended default', () => {
    // The relation, not the roster: the catalog is free to gain policies, and what must hold is
    // that `autonomy: 'unattended'` and `isUnattendedDefault` name the same row. A policy that
    // answers its own caps but is nobody's default is dead weight; one that is the default for
    // unwatched runs and still parks on them is the bug this whole feature exists to fix.
    for (const seed of seedRiskPolicies()) {
      expect(seed.autonomy === 'unattended', seed.id).toBe(seed.isUnattendedDefault)
    }
    expect(seedRiskPolicies().find((s) => s.isUnattendedDefault)?.id).toBe(
      UNATTENDED_RISK_POLICY_ID,
    )
  })

  it('gives the unattended default the SAME landing authority as the in-app one', () => {
    // The seed may decide that an unwatched run should not wait forever on an automation budget.
    // It may NOT decide that an unwatched run gets to land what an operator's own thresholds
    // would have held, so every field outside its own two concerns is Balanced's, and this is
    // what stops the next edit quietly widening it.
    const unattended = seedRiskPolicies().find((s) => s.id === UNATTENDED_RISK_POLICY_ID)!
    const balanced = seedRiskPolicies().find((s) => s.isDefault)!
    const {
      autonomy: _a,
      isDefault: _d,
      isUnattendedDefault: _u,
      name: _n,
      id: _i,
      version: _v,
      // The posture's own knobs, asserted below for DIRECTION rather than for equality. Excluded
      // here rather than dropped from the comparison silently: this list is the whole set of
      // fields the unattended seed is allowed to differ on, so adding an entry is the decision.
      ...authority
    } = { ...unattended, ...Object.fromEntries(POSTURE_FIELDS.map((key) => [key, undefined])) }
    for (const key of Object.keys(authority) as (keyof typeof authority)[]) {
      if (authority[key] === undefined) continue
      expect(unattended[key], key).toEqual(balanced[key])
    }
  })

  it('narrows the unattended default only DOWNWARD, and only on the loops policy answers', () => {
    // Every field here is a budget whose exhaustion `autonomy: 'unattended'` settles, so spending
    // it buys an unwatched run nothing but tokens. What must never happen is the reverse: a budget
    // WIDER than the in-app default would mean an unwatched run grinding longer than a watched one
    // before reaching the same policy-given answer.
    const unattended = seedRiskPolicies().find((s) => s.id === UNATTENDED_RISK_POLICY_ID)!
    const balanced = seedRiskPolicies().find((s) => s.isDefault)!
    for (const key of [
      'maxRequirementIterations',
      'maxTesterQualityIterations',
      'judgeMaxBounces',
    ] as const) {
      expect(unattended[key], key).toBeLessThanOrEqual(balanced[key])
    }
    // NOT narrowed, and the exception is the point: exhausting the CI-fixer budget raises
    // `ci_failed`, a park this policy does not answer, so cutting it would produce one more stop
    // for a person rather than one fewer.
    expect(unattended.ciMaxAttempts).toBe(balanced.ciMaxAttempts)
  })
})

/**
 * The fields the unattended seed may differ from `Balanced` on: its posture, the loop budgets that
 * posture makes cheap, and the confidence floor only it reads. Everything else is landing
 * authority, which it may never move.
 */
const POSTURE_FIELDS = [
  'maxRequirementIterations',
  'maxTesterQualityIterations',
  'judgeMaxBounces',
  'minAutoAnswerConfidence',
] as const

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
