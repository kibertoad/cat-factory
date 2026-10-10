import { describe, expect, it } from 'vitest'
import { resolveRunServiceScope, stepConditionSatisfied } from './step-conditions.js'

describe('resolveRunServiceScope', () => {
  it('reads a frontend frame as the frontend half and anything else as the backend half', () => {
    expect(resolveRunServiceScope([{ type: 'frontend' }])).toEqual({
      frontend: true,
      backend: false,
    })
    expect(resolveRunServiceScope([{ type: 'service' }])).toEqual({
      frontend: false,
      backend: true,
    })
  })

  it('sets BOTH halves for a full-stack scope', () => {
    // The own frame plus an involved peer: the reason the two testers are one preset rather than
    // two, since this run genuinely has both a UI and an API to exercise.
    expect(resolveRunServiceScope([{ type: 'frontend' }, { type: 'service' }])).toEqual({
      frontend: true,
      backend: true,
    })
  })

  it('resolves an EMPTY scope when there are no frames, distinct from either half', () => {
    // Neither half set is the "could not resolve" state the condition check reads as
    // "nothing to judge" — see the satisfaction test below.
    expect(resolveRunServiceScope([])).toEqual({ frontend: false, backend: false })
  })
})

describe('stepConditionSatisfied', () => {
  const frontendOnly = { frontend: true, backend: false }
  const backendOnly = { frontend: false, backend: true }
  const fullStack = { frontend: true, backend: true }
  const unresolved = { frontend: false, backend: false }

  it('runs an unconditional step in every scope', () => {
    for (const scope of [frontendOnly, backendOnly, fullStack, unresolved]) {
      expect(stepConditionSatisfied(undefined, scope)).toBe(true)
      expect(stepConditionSatisfied(null, scope)).toBe(true)
    }
  })

  it('admits each condition in its own scope and refuses it in the other', () => {
    expect(stepConditionSatisfied({ serviceScope: 'frontend' }, frontendOnly)).toBe(true)
    expect(stepConditionSatisfied({ serviceScope: 'frontend' }, backendOnly)).toBe(false)
    expect(stepConditionSatisfied({ serviceScope: 'backend' }, backendOnly)).toBe(true)
    expect(stepConditionSatisfied({ serviceScope: 'backend' }, frontendOnly)).toBe(false)
  })

  it('admits BOTH conditions on a full-stack run', () => {
    expect(stepConditionSatisfied({ serviceScope: 'frontend' }, fullStack)).toBe(true)
    expect(stepConditionSatisfied({ serviceScope: 'backend' }, fullStack)).toBe(true)
  })

  it('runs a conditional step when the scope could not be resolved', () => {
    // A task outside any service frame: the platform cannot tell what the change touches, and
    // silently dropping a verification pass is the one outcome that must not follow from not
    // knowing. Fails safe to thoroughness, the direction `onMissingEstimate: 'run'` takes.
    expect(stepConditionSatisfied({ serviceScope: 'frontend' }, unresolved)).toBe(true)
    expect(stepConditionSatisfied({ serviceScope: 'backend' }, unresolved)).toBe(true)
  })
})
