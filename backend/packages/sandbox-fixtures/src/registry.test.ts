import { SANDBOX_REPO_FIXTURE_KINDS } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SANDBOX_FIXTURES,
  builtinFixture,
  builtinFixturesFor,
  toSandboxFixture,
} from './registry.js'

/**
 * The agent kinds this package authors fixtures for. Derived from the fixtures themselves rather
 * than hand-listed, so adding a kind's fixtures brings it under every assertion below and adding a
 * kind with only one fixture (or only one difficulty) fails instead of shipping thin.
 */
const AUTHORED_KINDS = [...new Set(BUILTIN_SANDBOX_FIXTURES.map((f) => f.agentKind))]

describe('BUILTIN_SANDBOX_FIXTURES', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_SANDBOX_FIXTURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers every authored agent kind across a range of difficulties', () => {
    for (const kind of AUTHORED_KINDS) {
      const fixtures = builtinFixturesFor(kind)
      expect(fixtures.length, `${kind} needs more than one fixture`).toBeGreaterThanOrEqual(2)
      // At least one easy and one hard option per agent (the simple → complex range): a library
      // that is all-hard cannot tell a weak model from a broken one, and all-easy cannot rank.
      const difficulties = new Set(fixtures.map((f) => f.difficulty))
      expect(
        difficulties.has('simple') || difficulties.has('moderate'),
        `${kind} has no simple or moderate fixture`,
      ).toBe(true)
      expect(difficulties.has('complex'), `${kind} has no complex fixture`).toBe(true)
    }
  })

  it('authors one fixture kind per agent kind', () => {
    // The library is filtered by fixture kind, and the catalog maps each agent to the kinds it
    // claims. A fixture filed under another agent's kind would be offered to that agent and graded
    // on its rubric.
    for (const kind of AUTHORED_KINDS) {
      const kinds = new Set(builtinFixturesFor(kind).map((f) => f.kind))
      expect([...kinds], `${kind} spreads across fixture kinds`).toHaveLength(1)
    }
  })

  it('only authors inline (no-repo) fixtures', () => {
    // A repo fixture needs a `repoRef` naming a repository, which no deployment-neutral builtin can
    // supply, and the run-driver refuses one anyway. Asserted against the contract's own repo-kind
    // list so a new repo kind is covered without a second edit here.
    for (const f of BUILTIN_SANDBOX_FIXTURES) {
      expect(SANDBOX_REPO_FIXTURE_KINDS as readonly string[], f.id).not.toContain(f.kind)
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

  it('gives every fixture at least one high-impact and one tricky expectation', () => {
    // The two objective signals are asymmetric: `impactRecall` needs something whose miss actually
    // hurts, and `wowBonus` divides by the tricky total, so a fixture with nothing tricky scores a
    // flat 1 for every answer and ranks nothing. A fixture missing either grades but discriminates
    // on only one axis, which is invisible in the grid.
    for (const f of BUILTIN_SANDBOX_FIXTURES) {
      expect(
        f.expectations.some((e) => e.impact >= 4),
        `${f.id} has no high-impact expectation, so impactRecall cannot punish a weak answer`,
      ).toBe(true)
      expect(
        f.expectations.some((e) => e.trickiness >= 4),
        `${f.id} has no tricky expectation, so wowBonus is a constant 1`,
      ).toBe(true)
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

  it('keeps every matchHint short enough to plausibly match', () => {
    // A hint is matched as a contiguous run of word tokens, so a long one is effectively a demand
    // for verbatim reproduction and silently scores "missed" forever. Six tokens is already
    // generous for a phrase a model would produce on its own.
    for (const f of BUILTIN_SANDBOX_FIXTURES) {
      for (const e of f.expectations) {
        for (const hint of e.matchHints) {
          const tokens = hint.toLowerCase().match(/[a-z0-9]+/g) ?? []
          expect(
            tokens.length,
            `${f.id}/${e.id}: hint "${hint}" is too long to match`,
          ).toBeLessThan(7)
          expect(
            tokens.length,
            `${f.id}/${e.id}: hint "${hint}" has no word tokens`,
          ).toBeGreaterThan(0)
        }
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
