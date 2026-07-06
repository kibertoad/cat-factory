import { describe, expect, it } from 'vitest'
import { FRAGMENTS, FRAGMENTS_BY_ID, getFragment } from '../index.js'
import { migrationFragments } from './migration.js'

// The `migration.*` collection is the default fragment pack the `preset_tech_migration`
// initiative preset applies (T4). These assertions lock the collection's shape (so a
// later edit can't silently break the catalog contract the preset's `defaultFragmentIds`
// rely on) and its intent (so the behaviour-preservation gotchas the tracker calls out
// stay in the guidance).

const SEMVER = /^\d+\.\d+\.\d+$/
const EXPECTED_IDS = [
  'migration.discipline',
  'migration.behaviour-preservation',
  'migration.confidence-case',
]

describe('migration fragment collection', () => {
  it('exposes exactly the three expected migration fragments', () => {
    expect(migrationFragments.map((f) => f.id).sort()).toEqual([...EXPECTED_IDS].sort())
  })

  it('is well-formed: migration-namespaced ids, Migration category, filled bodies', () => {
    for (const fragment of migrationFragments) {
      expect(fragment.id.startsWith('migration.')).toBe(true)
      expect(fragment.category).toBe('Migration')
      expect(fragment.version).toMatch(SEMVER)
      expect(fragment.title.trim().length).toBeGreaterThan(0)
      expect(fragment.summary.trim().length).toBeGreaterThan(0)
      expect(fragment.body.trim().length).toBeGreaterThan(0)
      // Every migration fragment steers a specific set of agent roles (a picker hint).
      expect(fragment.appliesTo?.agentKinds?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('has ids unique within the collection', () => {
    const ids = migrationFragments.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is wired into the universal catalog and resolvable by id', () => {
    for (const fragment of migrationFragments) {
      expect(FRAGMENTS_BY_ID.get(fragment.id)).toBe(fragment)
      expect(getFragment(fragment.id)).toBe(fragment)
    }
  })

  it('does not collide with any other catalog id (global ids stay unique)', () => {
    const ids = FRAGMENTS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('migration fragment intent', () => {
  it('behaviour-preservation forbids the set-based → app-side N+1 regression', () => {
    const body = getFragment('migration.behaviour-preservation')!.body.toLowerCase()
    // The tracker's headline behaviour-preservation trap: a set-based op must not become a loop.
    expect(body).toContain('set-based')
    expect(body).toContain('n+1')
    // Pin outcomes at a seam, never internals/vendor mechanics.
    expect(body).toContain('seam')
    expect(body).toContain('outcome')
  })

  it('confidence-case demands named, per-touchpoint evidence bounded by the coverage bar', () => {
    const body = getFragment('migration.confidence-case')!.body.toLowerCase()
    expect(body).toContain('coverage bar')
    expect(body).toContain('waiver')
    // The LLM argues, the human audits — grounding is mandatory.
    expect(body).toContain('grounded')
    expect(body).toContain('safety net')
  })

  it('discipline mandates coverage before delivery and decommissioning the old path', () => {
    const body = getFragment('migration.discipline')!.body.toLowerCase()
    expect(body).toContain('coverage')
    expect(body).toContain('before')
    expect(body).toContain('blast zone')
    expect(body).toContain('remove the old path')
  })
})
