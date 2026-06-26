import { describe, expect, it } from 'vitest'
import type { KaizenVerifiedCombo } from '@cat-factory/contracts'
import {
  VERIFICATION_STREAK,
  comboKeyFor,
  isHighGrade,
  isVerified,
  nextComboState,
} from './kaizen.logic.js'

const combo = (over: Partial<KaizenVerifiedCombo> = {}): KaizenVerifiedCombo => ({
  comboKey: 'coder|m|1',
  agentKind: 'coder',
  model: 'm',
  promptVersion: 1,
  consecutiveHighGrades: 0,
  verified: false,
  verifiedAt: null,
  updatedAt: 0,
  ...over,
})

const grading = (grade: number | null, recommendations: string[] = []) => ({
  comboKey: 'coder|m|1',
  agentKind: 'coder',
  model: 'm',
  promptVersion: 1,
  grade,
  recommendations,
})

describe('comboKeyFor', () => {
  it('joins agentKind, model and promptVersion', () => {
    expect(comboKeyFor('coder', 'claude', 3)).toBe('coder|claude|3')
  })
})

describe('isHighGrade', () => {
  it('is true only for top grade with no recommendations', () => {
    expect(isHighGrade(5, [])).toBe(true)
    expect(isHighGrade(5, ['tweak the prompt'])).toBe(false)
    expect(isHighGrade(4, [])).toBe(false)
    expect(isHighGrade(null, [])).toBe(false)
  })
})

describe('nextComboState', () => {
  it('increments the streak on a high grade', () => {
    const next = nextComboState(combo({ consecutiveHighGrades: 2 }), grading(5), 100)
    expect(next.consecutiveHighGrades).toBe(3)
    expect(next.verified).toBe(false)
    expect(next.updatedAt).toBe(100)
  })

  it('resets the streak on a low grade or any recommendation', () => {
    expect(
      nextComboState(combo({ consecutiveHighGrades: 4 }), grading(3), 1).consecutiveHighGrades,
    ).toBe(0)
    expect(
      nextComboState(combo({ consecutiveHighGrades: 4 }), grading(5, ['x']), 1)
        .consecutiveHighGrades,
    ).toBe(0)
  })

  it('verifies once the streak reaches the threshold', () => {
    let state = combo()
    for (let i = 0; i < VERIFICATION_STREAK; i++) {
      state = nextComboState(state, grading(5), i + 1)
    }
    expect(state.consecutiveHighGrades).toBe(VERIFICATION_STREAK)
    expect(state.verified).toBe(true)
    expect(state.verifiedAt).toBe(VERIFICATION_STREAK)
    expect(isVerified(state)).toBe(true)
  })

  it('starts from zero for a combo with no prior state', () => {
    expect(nextComboState(null, grading(5), 1).consecutiveHighGrades).toBe(1)
    expect(nextComboState(null, grading(2), 1).consecutiveHighGrades).toBe(0)
  })
})
