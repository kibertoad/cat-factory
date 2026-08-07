import { describe, expect, it } from 'vitest'
import {
  INITIATIVE_AGENT_KINDS,
  INITIATIVE_ANALYST_AGENT_KIND,
  INITIATIVE_COMMITTER_AGENT_KIND,
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  INITIATIVE_PLANNER_AGENT_KIND,
  hasInitiativeKinds,
  isInitiativeAgentKind,
} from './initiative-logic.js'

// The engine's runnable guard is BIDIRECTIONAL: a pipeline holding any initiative-planning step
// may only start on an initiative block, and an initiative block accepts only such a pipeline.
// Both halves read these two predicates, so a kind that stops being recognised does not fail:
// it lets a planning pipeline start on an ordinary task, and the planner then authors a plan
// against a block that has nowhere to commit it.

describe('isInitiativeAgentKind', () => {
  it('recognises every member of the planning family', () => {
    for (const kind of INITIATIVE_AGENT_KINDS) {
      expect(isInitiativeAgentKind(kind), kind).toBe(true)
    }
    // Derived from the set the guard itself reads, and asserted non-empty so the loop above
    // cannot pass vacuously.
    expect(INITIATIVE_AGENT_KINDS.size).toBeGreaterThan(0)
  })

  it('names each of the four kinds it covers', () => {
    expect([...INITIATIVE_AGENT_KINDS].sort()).toEqual(
      [
        INITIATIVE_INTERVIEWER_AGENT_KIND,
        INITIATIVE_ANALYST_AGENT_KIND,
        INITIATIVE_PLANNER_AGENT_KIND,
        INITIATIVE_COMMITTER_AGENT_KIND,
      ].sort(),
    )
  })

  it('rejects an ordinary build kind', () => {
    expect(isInitiativeAgentKind('coder')).toBe(false)
    expect(isInitiativeAgentKind('merger')).toBe(false)
    expect(isInitiativeAgentKind('')).toBe(false)
  })

  it('matches the whole kind, not a prefix of one', () => {
    expect(isInitiativeAgentKind('initiative-planner-v2')).toBe(false)
    expect(isInitiativeAgentKind('initiative')).toBe(false)
  })
})

describe('hasInitiativeKinds', () => {
  it('is true when ANY step in the pipeline is a planning step', () => {
    expect(hasInitiativeKinds(['coder', INITIATIVE_PLANNER_AGENT_KIND, 'merger'])).toBe(true)
    expect(hasInitiativeKinds([INITIATIVE_INTERVIEWER_AGENT_KIND])).toBe(true)
  })

  it('is false for a pipeline of ordinary kinds, and for an empty one', () => {
    expect(hasInitiativeKinds(['coder', 'tester', 'merger'])).toBe(false)
    expect(hasInitiativeKinds([])).toBe(false)
  })
})
