import { describe, it, expect } from 'vitest'
import { useSkillsStore } from '~/stores/skills'
import { usePipelinesStore } from '~/stores/pipelines'
import type { SkillSummary } from '~/types/domain'

const summary = (id: string, name = id, group: SkillSummary['group'] = 'other'): SkillSummary => ({
  id,
  name,
  description: `${name} desc`,
  group,
})

/**
 * The skill picker spans two stores: the snapshot-hydrated `useSkillsStore` (the catalog the
 * builder's `USelect` binds against) and the per-step `skillId` helpers on `usePipelinesStore`.
 * These pin the behaviours the builder relies on (ADR 0024 slice 3).
 */
describe('skills picker store — snapshot-hydrated catalog', () => {
  it('hydrate is a straight replace (a later hydrate does not merge with the earlier one)', () => {
    const skills = useSkillsStore()
    expect(skills.catalog).toEqual([])

    skills.hydrate([summary('sk_a'), summary('sk_b')])
    expect(skills.catalog.map((s) => s.id)).toEqual(['sk_a', 'sk_b'])

    // A resync (or a board switch) replaces the whole list — no stale ids linger.
    skills.hydrate([summary('sk_c')])
    expect(skills.catalog.map((s) => s.id)).toEqual(['sk_c'])

    // An empty hydrate (feature off / account with no skills) clears it.
    skills.hydrate([])
    expect(skills.catalog).toEqual([])
  })
})

describe('skills store — the review task’s queue offers only review skills', () => {
  it('offers the review group in catalog order and nothing else', () => {
    const skills = useSkillsStore()
    skills.hydrate([
      summary('sk_build', 'Scaffold a service', 'build'),
      summary('sk_sec', 'Security review', 'review'),
      summary('sk_perf', 'Performance review', 'review'),
      summary('sk_loose', 'Uncategorised', 'other'),
    ])
    expect(skills.reviewSkills.map((s) => s.id)).toEqual(['sk_sec', 'sk_perf'])
  })

  it('offers nothing when the account has authored no review skills', () => {
    // The ordinary state for an account whose catalog is all build playbooks. The picker renders
    // its empty note from this; it must not fall back to offering the whole catalog.
    const skills = useSkillsStore()
    skills.hydrate([summary('sk_build', 'Scaffold a service', 'build')])
    expect(skills.reviewSkills).toEqual([])
  })
})

describe('pipelines store — per-step skill picker helpers', () => {
  it('sets, reads and clears a draft skill step’s skillId', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('skill')
    expect(pipelines.draftSkillId(0)).toBeUndefined()

    pipelines.setDraftSkillId(0, 'sk_1')
    expect(pipelines.draftSkillId(0)).toBe('sk_1')
    expect(pipelines.draftStepOptions[0]).toEqual({ skillId: 'sk_1' })

    // Clearing drops the field and, with the bag now empty, normalizes the entry back to null.
    pipelines.setDraftSkillId(0, undefined)
    expect(pipelines.draftSkillId(0)).toBeUndefined()
    expect(pipelines.draftStepOptions[0]).toBeNull()
  })

  it('merges into the options bag rather than clobbering other per-step options', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('skill')
    // Seed a co-existing option (as a requirements-review opt-out would).
    pipelines.draftStepOptions[0] = { autoRecommend: false }

    pipelines.setDraftSkillId(0, 'sk_1')
    expect(pipelines.draftStepOptions[0]).toEqual({ autoRecommend: false, skillId: 'sk_1' })

    // Clearing only the skill leaves the other option (bag not empty ⇒ entry survives).
    pipelines.setDraftSkillId(0, undefined)
    expect(pipelines.draftStepOptions[0]).toEqual({ autoRecommend: false })
  })
})
