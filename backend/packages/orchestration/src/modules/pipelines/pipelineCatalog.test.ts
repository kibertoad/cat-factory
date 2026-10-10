import { describe, expect, it } from 'vitest'
import { offeredPipelines, retiredPipelines, seedPipelines } from '@cat-factory/kernel'

// What the built-in catalog CONTAINS, as opposed to whether each entry is well-shaped (that is the
// sibling `pipelineShape.test.ts`). Three memberships, and the difference between them is the
// whole design: a LIVE pipeline is offered and runnable, a RETIRED one is a tombstone offering a
// seeded workspace its removal, and an INTERNAL one is withheld from every listing while still
// resolving for the flow that starts it by id. Confusing the last two breaks a feature silently.
describe('built-in pipeline catalog membership', () => {
  it('the retired build variants are gone from the catalog and tombstoned', () => {
    const live = new Set(seedPipelines().map((p) => p.id))
    for (const retired of [
      'pl_quick',
      'pl_fullstack',
      'pl_dep_update',
      'pl_pr_review',
      'pl_human_review',
      'pl_integrate',
      // The catalog narrowing: a near-duplicate of the ladder (`pl_frontend`), a build tail behind
      // a recurring head (`pl_tech_debt`), and three single-step presets now reachable as
      // single-kind runs or builder steps.
      'pl_frontend',
      'pl_tech_debt',
      'pl_blueprint',
      'pl_spec',
      'pl_environment_analysis',
    ]) {
      expect(live.has(retired), `${retired} must be withdrawn`).toBe(false)
    }
    // Every `replacedBy` target a tombstone names must still be live, or the advisory offers a
    // replacement the workspace cannot switch to. Derived from the tombstones themselves rather
    // than a hand-kept list, so a retirement added with a stale target fails here.
    for (const { id, replacedBy } of retiredPipelines()) {
      if (replacedBy) expect(live.has(replacedBy), `${id} → ${replacedBy}`).toBe(true)
    }
  })

  it('keeps the INTERNAL pipelines resolvable but out of every offered listing', () => {
    // `pl_code_comments` is the documentation-refresh preset's spawn target: retiring it would
    // take that doc type down with it, and listing it offers a build preset whose whole scope is
    // "edit comments". So it stays in the catalog, marked internal, and out of what is offered.
    const catalog = seedPipelines()
    const commentsPipeline = catalog.find((p) => p.id === 'pl_code_comments')
    expect(commentsPipeline?.internal, 'pl_code_comments must be internal').toBe(true)
    expect(offeredPipelines(catalog, catalog).map((p) => p.id)).not.toContain('pl_code_comments')
    // An internal pipeline is NOT a tombstone: offering its removal would break its caller.
    expect(retiredPipelines().map((p) => p.id)).not.toContain('pl_code_comments')
  })
})
