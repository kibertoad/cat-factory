import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  clearsRequirementFindingFloor,
  parseRequirementFindingFloor,
  parseRequirementFloorProgression,
  requirementFloorProgressionSchema,
  resolveRequirementFindingFloor,
} from './requirement-finding-floor.js'

const progressive = {
  requirementFindingFloor: 'medium' as const,
  requirementFloorProgression: { mediumFrom: 0.3, lowFrom: 0.7 },
}
const estimate = (complexity: number, risk = 0, impact = 0) => ({ complexity, risk, impact })

describe('resolveRequirementFindingFloor', () => {
  it('keeps the fixed floor whatever the estimate says when there is no progression', () => {
    expect(
      resolveRequirementFindingFloor(
        { requirementFindingFloor: 'high', requirementFloorProgression: null },
        estimate(0.95),
      ),
    ).toEqual({ severity: 'high', basis: 'fixed', score: null })
  })

  it('falls back to the fixed floor, and says so, when a progressive policy has no estimate', () => {
    expect(resolveRequirementFindingFloor(progressive, null)).toEqual({
      severity: 'medium',
      basis: 'no_estimate',
      score: null,
    })
  })

  it('lowers the floor as the highest estimate axis rises, inclusive at each band edge', () => {
    expect(resolveRequirementFindingFloor(progressive, estimate(0.29)).severity).toBe('high')
    expect(resolveRequirementFindingFloor(progressive, estimate(0.3)).severity).toBe('medium')
    expect(resolveRequirementFindingFloor(progressive, estimate(0.69)).severity).toBe('medium')
    expect(resolveRequirementFindingFloor(progressive, estimate(0.7)).severity).toBe('low')
  })

  it('reads the highest of the three axes, not the first', () => {
    expect(resolveRequirementFindingFloor(progressive, estimate(0.1, 0.2, 0.8))).toEqual({
      severity: 'low',
      basis: 'estimate',
      score: 0.8,
    })
  })
})

describe('the stored forms', () => {
  it('refuses a progression whose bands cross', () => {
    expect(
      v.safeParse(requirementFloorProgressionSchema, { mediumFrom: 0.8, lowFrom: 0.4 }).success,
    ).toBe(false)
  })

  it('reads an unparseable progression as none and an unknown floor as the default', () => {
    expect(parseRequirementFloorProgression('{"mediumFrom":0.9,"lowFrom":0.1}')).toBeNull()
    expect(parseRequirementFloorProgression('not json')).toBeNull()
    expect(parseRequirementFindingFloor('trivial')).toBe('medium')
    expect(parseRequirementFindingFloor('high')).toBe('high')
  })
})

describe('clearsRequirementFindingFloor', () => {
  it('raises a finding at or above the floor', () => {
    expect(clearsRequirementFindingFloor('medium', 'medium')).toBe(true)
    expect(clearsRequirementFindingFloor('high', 'medium')).toBe(true)
    expect(clearsRequirementFindingFloor('low', 'medium')).toBe(false)
  })
})
