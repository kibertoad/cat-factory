import { describe, expect, it } from 'vitest'
import { FRAGMENTS, getFragment } from '../index.js'
import { deploymentFragments, DEPLOYMENT_FRAGMENT_IDS } from './deployment.js'

// The `deployment.*` collection ships the containerized-service standards a design review kept
// re-deriving one finding at a time (kaizen KZ-0005). These assertions guard the collection's
// RELATIONSHIP to the catalog and the machinery that reads it, never the prose: asserting a body
// contains the words just written would give the test and the source one oracle. Two properties
// here are worth more than a wording check:
//
//  - every member is reachable through the shipped catalog, which is the real bug a new
//    collection ships with (a file never spread into FRAGMENTS resolves to nothing at
//    prompt-composition time and the picker simply never lists it);
//  - every member carries a `brief`, because all three are scoped to `coder`, an implementer kind
//    whose system prompt is re-sent on every turn. A missing brief there is not a failure, it is
//    silently folding the FULL body onto every turn of the loop the brief tier exists to protect.

const SEMVER = /^\d+\.\d+\.\d+$/

describe('deployment fragment collection', () => {
  it('is non-empty and every member follows the catalog conventions', () => {
    expect(deploymentFragments.length).toBeGreaterThan(0)
    for (const fragment of deploymentFragments) {
      expect(fragment.id.startsWith('deployment.')).toBe(true)
      expect(fragment.category).toBe('Deployment')
      expect(fragment.version).toMatch(SEMVER)
      expect(fragment.title.trim().length).toBeGreaterThan(0)
      expect(fragment.summary.trim().length).toBeGreaterThan(0)
      expect(fragment.body.trim().length).toBeGreaterThan(0)
      // `appliesTo` is the picker hint; every deployment fragment declares the roles it steers.
      expect(fragment.appliesTo?.agentKinds?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('carries a hand-written brief for every fragment that can reach an implementer kind', () => {
    // The rule from the package README: a fragment reachable by a `brief-standards` kind carries a
    // brief, and a brief compresses the standard rather than dropping a rule. Length is the only
    // half of that a test can hold: it must be materially shorter than the body it condenses, and
    // long enough not to be a title in disguise.
    for (const fragment of deploymentFragments.filter((f) =>
      f.appliesTo?.agentKinds?.includes('coder'),
    )) {
      expect(fragment.brief, `${fragment.id} is folded onto every coder turn`).toBeDefined()
      expect(fragment.brief!.length).toBeLessThan(fragment.body.length)
      expect(fragment.brief!.length).toBeGreaterThan(80)
    }
  })

  it('is wired into the universal catalog and resolvable by id', () => {
    for (const fragment of deploymentFragments) {
      expect(getFragment(fragment.id)).toBe(fragment)
    }
  })

  it('exposes its ids in catalog order, derived from the definitions', () => {
    // Derived rather than pinned: a fourth fragment must not need this list edited by hand, which
    // is what makes the export safe for a deployment to use as a default set.
    expect(DEPLOYMENT_FRAGMENT_IDS).toEqual(deploymentFragments.map((f) => f.id))
  })

  it('introduces no id collision with the rest of the catalog', () => {
    const ids = FRAGMENTS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
