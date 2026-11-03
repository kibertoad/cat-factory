import { describe, expect, it } from 'vitest'
import { seedRiskPolicies, riskPolicyFromSeed } from '@cat-factory/kernel'
import { applyRiskPolicyPatch } from './riskPolicyPatch.js'

const stored = {
  ...riskPolicyFromSeed(seedRiskPolicies()[0]!, 1),
  requirementFloorProgression: { mediumFrom: 0.3, lowFrom: 0.7 },
}

describe('applyRiskPolicyPatch', () => {
  it('keeps every field the patch leaves out', () => {
    expect(applyRiskPolicyPatch(stored, { maxRisk: 0.2 })).toEqual({ ...stored, maxRisk: 0.2 })
  })

  it('applies an explicit null, which is how the progression is switched off', () => {
    const patched = applyRiskPolicyPatch(stored, { requirementFloorProgression: null })
    expect(patched.requirementFloorProgression).toBeNull()
  })

  it('never applies a default claim, which the board tier guards and applies itself', () => {
    const patched = applyRiskPolicyPatch(stored, { isDefault: false, isUnattendedDefault: true })
    expect(patched.isDefault).toBe(stored.isDefault)
    expect(patched.isUnattendedDefault).toBe(stored.isUnattendedDefault)
  })
})
