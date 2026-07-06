import { describe, expect, it } from 'vitest'
import { FRAGMENTS, getFragment } from '../index.js'
import { migrationFragments } from './migration.js'

// The `migration.*` collection is the default fragment pack the `preset_tech_migration`
// initiative preset applies (T4). These assertions are deliberately limited to INVARIANTS
// the catalog machinery relies on — NOT the fragment prose. Asserting a body contains the
// words we just wrote would only restate the constant (the test and the source would share
// one oracle), so wording is left to review. What's worth guarding is the collection's
// RELATIONSHIP to the catalog: that it is wired in, resolvable, conventionally shaped, and
// collision-free — the mistakes that actually ship broken.

const SEMVER = /^\d+\.\d+\.\d+$/

describe('migration fragment collection', () => {
  it('is non-empty and every member follows the catalog conventions', () => {
    // A convention guard that scales to any future migration fragment, not a check of one body.
    expect(migrationFragments.length).toBeGreaterThan(0)
    for (const fragment of migrationFragments) {
      expect(fragment.id.startsWith('migration.')).toBe(true)
      expect(fragment.category).toBe('Migration')
      expect(fragment.version).toMatch(SEMVER)
      expect(fragment.title.trim().length).toBeGreaterThan(0)
      expect(fragment.summary.trim().length).toBeGreaterThan(0)
      expect(fragment.body.trim().length).toBeGreaterThan(0)
      // `appliesTo` is a picker hint; every migration fragment declares the roles it steers.
      expect(fragment.appliesTo?.agentKinds?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('is wired into the universal catalog and resolvable by id', () => {
    // The real bug this catches: a collection file that was never spread into FRAGMENTS, so the
    // preset's `defaultFragmentIds` resolve to nothing at prompt-composition time.
    for (const fragment of migrationFragments) {
      expect(getFragment(fragment.id)).toBe(fragment)
    }
  })

  it('introduces no id collision with the rest of the catalog', () => {
    // Ids are persisted on blocks, so a duplicate would silently shadow another fragment's body.
    const ids = FRAGMENTS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
