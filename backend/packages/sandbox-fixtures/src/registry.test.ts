import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SANDBOX_FIXTURES,
  builtinFixture,
  builtinFixturesFor,
  toSandboxFixture,
} from './registry.js'

describe('BUILTIN_SANDBOX_FIXTURES', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_SANDBOX_FIXTURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers each supported agent kind across a range of difficulties', () => {
    for (const kind of [
      'requirements-review',
      'clarity-review',
      'reviewer',
      'architect-companion',
    ]) {
      const fixtures = builtinFixturesFor(kind)
      expect(fixtures.length).toBeGreaterThanOrEqual(2)
      // At least one easy and one hard option per agent (the simple → complex range).
      const difficulties = new Set(fixtures.map((f) => f.difficulty))
      expect(difficulties.has('simple') || difficulties.has('moderate')).toBe(true)
      expect(difficulties.has('complex')).toBe(true)
    }
  })

  it('only authors inline (no-repo) fixtures', () => {
    for (const f of BUILTIN_SANDBOX_FIXTURES) {
      expect(['requirements', 'clarity', 'architecture', 'code-review']).toContain(f.kind)
    }
  })

  it('grades every expectation on the 1..5 trickiness/impact scale with unique ids', () => {
    for (const f of BUILTIN_SANDBOX_FIXTURES) {
      expect(f.expectations.length).toBeGreaterThan(0)
      const expIds = f.expectations.map((e) => e.id)
      expect(new Set(expIds).size).toBe(expIds.length)
      for (const e of f.expectations) {
        expect(e.trickiness).toBeGreaterThanOrEqual(1)
        expect(e.trickiness).toBeLessThanOrEqual(5)
        expect(e.impact).toBeGreaterThanOrEqual(1)
        expect(e.impact).toBeLessThanOrEqual(5)
      }
    }
  })

  it('gives every expectation explicit matchHints (summaries are full sentences)', () => {
    // The deterministic scorer falls back to matching the `summary` as a contiguous token
    // run when `matchHints` is empty. Our summaries are full questions/sentences, which a
    // candidate never reproduces verbatim — so a hint-less expectation is unmatchable and
    // is scored "missed" for every answer. Require hints so that can't happen by omission.
    for (const f of BUILTIN_SANDBOX_FIXTURES) {
      for (const e of f.expectations) {
        expect(e.matchHints.length, `${f.id}/${e.id} needs matchHints`).toBeGreaterThan(0)
      }
    }
  })

  it('every fixture projects to a valid contract SandboxFixture', () => {
    for (const f of BUILTIN_SANDBOX_FIXTURES) {
      const fixture = toSandboxFixture(f, 1_700_000_000_000)
      expect(fixture.origin).toBe('builtin')
      expect(fixture.repoRef).toBeNull()
      expect(fixture.payload).not.toBeNull()
      expect(fixture.objective).toMatchObject({ kind: 'findings' })
    }
  })

  it('looks a fixture up by id', () => {
    expect(builtinFixture('review-jwt-verify-complex')?.agentKind).toBe('reviewer')
    expect(builtinFixture('does-not-exist')).toBeUndefined()
  })
})
