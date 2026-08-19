import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { isSkillGroup, normalizeSkillGroup, SKILL_GROUPS } from './skill-library.js'
import { MAX_REVIEW_SKILLS, taskTypeFieldsSchema } from './primitives.js'

// The group vocabulary is CLOSED and PERSISTED: a synced row carries whatever its manifest
// declared, so the narrowing has to be total over strings, not merely over the union. These pin
// the two properties every reader depends on (a known value survives unchanged; an unknown one
// lands on `other` rather than throwing or being guessed onto a neighbour), plus the review
// queue's own bound.

describe('normalizeSkillGroup', () => {
  it('keeps every group this build knows, however the manifest cased it', () => {
    // Derived from the picklist, so a group added to the vocabulary is covered here by existing
    // rather than needing this test re-pinned.
    for (const group of SKILL_GROUPS) {
      expect(normalizeSkillGroup(group)).toBe(group)
      expect(normalizeSkillGroup(` ${group.toUpperCase()} `)).toBe(group)
      expect(isSkillGroup(group)).toBe(true)
    }
  })

  it('lands anything else on the unclassified shelf without guessing a neighbour', () => {
    // `sekurity` is a typo for a group that exists, and `security` is a plausible name for one
    // that does not. Neither becomes `review`: nothing knows what the author meant, and a wrong
    // shelf is what would put a playbook in front of the wrong step.
    expect(normalizeSkillGroup('sekurity')).toBe('other')
    expect(normalizeSkillGroup('security')).toBe('other')
    expect(normalizeSkillGroup('')).toBe('other')
    expect(normalizeSkillGroup(null)).toBe('other')
    expect(normalizeSkillGroup(undefined)).toBe('other')
    expect(isSkillGroup('security')).toBe(false)
  })
})

describe('a review task’s queued skills', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `src:s:skill-${i}`)

  it('accepts a queue up to the cap and refuses one past it', () => {
    const atCap = v.parse(taskTypeFieldsSchema, { reviewSkillIds: ids(MAX_REVIEW_SKILLS) })
    expect(atCap.reviewSkillIds).toHaveLength(MAX_REVIEW_SKILLS)
    expect(() =>
      v.parse(taskTypeFieldsSchema, { reviewSkillIds: ids(MAX_REVIEW_SKILLS + 1) }),
    ).toThrow()
  })

  it('refuses a blank id, which would resolve against nothing at dispatch', () => {
    expect(() => v.parse(taskTypeFieldsSchema, { reviewSkillIds: ['   '] })).toThrow()
  })
})
