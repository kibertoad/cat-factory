import { describe, expect, it } from 'vitest'
import { SKILL_GROUPS } from '@cat-factory/contracts'
import {
  SKILL_GROUP_ICONS,
  SKILL_GROUP_LABEL_KEYS,
  SKILL_GROUP_ORDER,
  skillsInGroup,
} from '~/utils/skills'
import type { SkillSummary } from '~/types/domain'

// The group maps are what a picker renders a shelf from, and the vocabulary they cover lives in
// contracts. What is asserted here is the RELATION that has to hold (every member of the shared
// vocabulary is covered exactly once), never a hand-written count: adding a group must fail with
// its name rather than teaching the next person to re-pin a number.

const skill = (id: string, group: SkillSummary['group']): SkillSummary => ({
  id,
  name: id,
  description: `${id} desc`,
  group,
})

describe('skill group presentation', () => {
  it('gives every group in the shared vocabulary a label key and an icon', () => {
    for (const group of SKILL_GROUPS) {
      expect(SKILL_GROUP_LABEL_KEYS[group]).toMatch(/^skills\.groups\./)
      expect(SKILL_GROUP_ICONS[group]).toMatch(/^i-lucide-/)
    }
  })

  it('orders every group exactly once, with the unclassified shelf last', () => {
    expect([...SKILL_GROUP_ORDER].sort()).toEqual([...SKILL_GROUPS].sort())
    expect(SKILL_GROUP_ORDER.at(-1)).toBe('other')
  })
})

describe('skillsInGroup', () => {
  it('keeps catalog order and admits only the asked-for group', () => {
    const catalog = [
      skill('sk_build', 'build'),
      skill('sk_sec', 'review'),
      skill('sk_other', 'other'),
      skill('sk_perf', 'review'),
    ]
    expect(skillsInGroup(catalog, 'review').map((s) => s.id)).toEqual(['sk_sec', 'sk_perf'])
    // A skill whose manifest declared an unknown group arrives already normalized to `other`, so
    // it is offered on the unclassified shelf rather than everywhere or nowhere.
    expect(skillsInGroup(catalog, 'other').map((s) => s.id)).toEqual(['sk_other'])
    expect(skillsInGroup(catalog, 'test')).toEqual([])
  })
})
