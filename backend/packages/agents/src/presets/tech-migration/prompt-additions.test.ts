import { describe, expect, it } from 'vitest'
import {
  INITIATIVE_AGENT_KINDS,
  INITIATIVE_ANALYST_AGENT_KIND,
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  INITIATIVE_PLANNER_AGENT_KIND,
} from '@cat-factory/kernel'
import { MIGRATION_PHASE_ID_ORDER, MIGRATION_PHASE_IDS } from './phases.js'
import {
  MIGRATION_ANALYST_PROMPT_ADDITION,
  MIGRATION_INTERVIEWER_PROMPT_ADDITION,
  MIGRATION_PLANNER_PROMPT_ADDITION,
  MIGRATION_PROMPT_ADDITIONS,
} from './prompt-additions.js'

// These tests guard the pack's INVARIANTS against an independent oracle — the canonical phase ids,
// the kernel kind constants, the individual exported constants — NOT the prose (which is its own
// source of truth; a wording edit must not "fail" a test, per the T4 review). What can actually
// break: a phase-id rename the planner brief doesn't follow (the id then no longer matches the
// template at ingest), the map keyed by the wrong / a non-planning kind (that entry is silently
// never consumed), or the map wired to the wrong constant.

describe('tech-migration phase ids', () => {
  it('orders all five ids exactly once, matching the keyed constant', () => {
    expect([...MIGRATION_PHASE_ID_ORDER]).toEqual([
      MIGRATION_PHASE_IDS.blastZone,
      MIGRATION_PHASE_IDS.coverage,
      MIGRATION_PHASE_IDS.transitionDesign,
      MIGRATION_PHASE_IDS.delivery,
      MIGRATION_PHASE_IDS.verifyDecommission,
    ])
    // No id duplicated (the ingest normalizer matches by id, so a dup would be ambiguous).
    expect(new Set(MIGRATION_PHASE_ID_ORDER).size).toBe(MIGRATION_PHASE_ID_ORDER.length)
    // Every id is a `migration-`-namespaced slug (the shape the template phase ids clamp allows).
    for (const id of MIGRATION_PHASE_ID_ORDER) expect(id).toMatch(/^migration-[a-z-]+$/)
  })
})

describe('tech-migration prompt-additions pack', () => {
  it('exposes non-empty steering for each planning kind', () => {
    for (const body of [
      MIGRATION_INTERVIEWER_PROMPT_ADDITION,
      MIGRATION_ANALYST_PROMPT_ADDITION,
      MIGRATION_PLANNER_PROMPT_ADDITION,
    ]) {
      expect(body.trim().length).toBeGreaterThan(0)
    }
  })

  it('wires the map to exactly the three planning kinds, each to its constant', () => {
    expect(Object.keys(MIGRATION_PROMPT_ADDITIONS).sort()).toEqual(
      [
        INITIATIVE_INTERVIEWER_AGENT_KIND,
        INITIATIVE_ANALYST_AGENT_KIND,
        INITIATIVE_PLANNER_AGENT_KIND,
      ].sort(),
    )
    expect(MIGRATION_PROMPT_ADDITIONS[INITIATIVE_INTERVIEWER_AGENT_KIND]).toBe(
      MIGRATION_INTERVIEWER_PROMPT_ADDITION,
    )
    expect(MIGRATION_PROMPT_ADDITIONS[INITIATIVE_ANALYST_AGENT_KIND]).toBe(
      MIGRATION_ANALYST_PROMPT_ADDITION,
    )
    expect(MIGRATION_PROMPT_ADDITIONS[INITIATIVE_PLANNER_AGENT_KIND]).toBe(
      MIGRATION_PLANNER_PROMPT_ADDITION,
    )
  })

  it('only steers real initiative-planning kinds (a bad key is silently never consumed)', () => {
    for (const kind of Object.keys(MIGRATION_PROMPT_ADDITIONS)) {
      expect(INITIATIVE_AGENT_KINDS.has(kind)).toBe(true)
    }
  })

  it('references every canonical phase id verbatim in the planner brief', () => {
    // The planner authors the phases, so its brief must name each id exactly as the template does —
    // a rename here that missed the brief would leave it pointing at a phase the plan no longer has.
    for (const id of MIGRATION_PHASE_ID_ORDER) {
      expect(MIGRATION_PLANNER_PROMPT_ADDITION).toContain(`\`${id}\``)
    }
  })
})
