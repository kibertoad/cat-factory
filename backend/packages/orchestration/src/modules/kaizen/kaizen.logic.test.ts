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

  it('keys a workspace-edited prompt apart from the shipped one', () => {
    expect(comboKeyFor('coder', 'claude', 3, 7)).toBe('coder|claude|3|w7')
  })

  it('keys a varied step by the variant id AND a fingerprint of its contribution', () => {
    // The fingerprint is what stops a re-worded variant inheriting the streak its previous
    // wording earned, since re-registering the same id is a supported way to re-word one.
    expect(
      comboKeyFor('coder', 'claude', 3, undefined, { id: 'org:tdd', fingerprint: 'abc' }),
    ).toBe('coder|claude|3|vorg:tdd@abc')
    expect(
      comboKeyFor('coder', 'claude', 3, undefined, { id: 'org:tdd', fingerprint: 'def' }),
    ).not.toBe(comboKeyFor('coder', 'claude', 3, undefined, { id: 'org:tdd', fingerprint: 'abc' }))
  })

  it('carries both suffixes, variant first, when a workspace edited a varied step kind', () => {
    expect(comboKeyFor('coder', 'claude', 3, 7, { id: 'org:tdd', fingerprint: 'abc' })).toBe(
      'coder|claude|3|vorg:tdd@abc|w7',
    )
  })

  it('leaves a variant that contributed NOTHING out of the key entirely', () => {
    // Withdrawn mid-run, or its replacement displaced by a workspace override with no addition of
    // its own: the text that ran is the shipped or workspace prompt alone, and the key describes
    // the text — so it must match the key an unvaried step of the same shape gets.
    expect(comboKeyFor('coder', 'claude', 3, undefined, { id: 'org:tdd' })).toBe('coder|claude|3')
    expect(comboKeyFor('coder', 'claude', 3, 7, { id: 'org:tdd' })).toBe('coder|claude|3|w7')
  })

  it('keeps the key an unvaried, unedited step always had', () => {
    // The migration property: every combo verified before variants existed keeps its key, so no
    // streak is silently reset by this feature landing.
    expect(comboKeyFor('coder', 'claude', 3, undefined, undefined)).toBe('coder|claude|3')
  })
})

describe('isHighGrade', () => {
  it('is true for a strong grade (>=4) with no recommendations', () => {
    expect(isHighGrade(5, [])).toBe(true)
    expect(isHighGrade(4, [])).toBe(true)
    expect(isHighGrade(5, ['tweak the prompt'])).toBe(false)
    expect(isHighGrade(4, ['tweak the prompt'])).toBe(false)
    expect(isHighGrade(3, [])).toBe(false)
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
