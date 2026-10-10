import { describe, expect, it } from 'vitest'
import type { PlatformFailureKindRule } from '~/types/execution'
import {
  AGENT_FAILURE_KINDS,
  FAILURE_KIND_KEYS,
  failureKindRuleFaults,
  hasFailureKindRuleFaults,
  isAgentFailureKind,
  MAX_FAILURE_KIND_RULES,
} from '~/utils/failureKinds'

describe('the failure-kind vocabulary', () => {
  it('offers exactly the kinds the contract declares, and labels every one', () => {
    // The map is what both the dashboard breakdown and the alert-rule picker read, so a kind
    // added to the contract without a label here would render a raw code in both.
    expect(AGENT_FAILURE_KINDS.length).toBeGreaterThan(0)
    for (const kind of AGENT_FAILURE_KINDS) expect(FAILURE_KIND_KEYS[kind]).toBeTruthy()
    expect(Object.keys(FAILURE_KIND_KEYS).sort()).toEqual([...AGENT_FAILURE_KINDS].sort())
  })

  it('recognises a current kind and refuses a retired or mistyped one', () => {
    // Re-exported from `@cat-factory/contracts` rather than reimplemented, because the backend
    // asks the identical question of an operator-typed kind in the env var. Pinned through the
    // SPA's own import path so the re-export cannot quietly disappear.
    expect(isAgentFailureKind('evicted')).toBe(true)
    // The case the predicate exists for: a kind that a release retired still arrives on stored
    // rules and old run rows, and must render as itself rather than as `undefined` or as
    // whichever current member a guess landed on.
    expect(isAgentFailureKind('evicetd')).toBe(false)
  })

  it('never offers more kinds than a rule list may hold, so the cap cannot bind first', () => {
    // What makes "one rule per kind" the binding limit in the editor, and therefore what lets
    // the add button simply stop rather than seeding a row the contract would refuse.
    expect(AGENT_FAILURE_KINDS.length).toBeLessThanOrEqual(MAX_FAILURE_KIND_RULES)
  })
})

describe('failureKindRuleFaults', () => {
  const rule = (over: Partial<PlatformFailureKindRule> = {}): PlatformFailureKindRule => ({
    kind: 'evicted',
    maxShare: 0.05,
    ...over,
  })

  it('accepts a well-formed set of rules', () => {
    expect(
      failureKindRuleFaults([rule(), rule({ kind: 'timeout', maxShare: 1, minCount: 3 })]),
    ).toEqual({ rows: [], tooMany: false })
    expect(failureKindRuleFaults([])).toEqual({ rows: [], tooMany: false })
    expect(hasFailureKindRuleFaults(failureKindRuleFaults([rule()]))).toBe(false)
  })

  it('names the 1-based rows the backend would refuse', () => {
    // The share bounds mirror the contract: 0 is satisfied by any distribution (including a kind
    // that never occurred), and there is nothing above "all of them".
    expect(failureKindRuleFaults([rule({ maxShare: 0 })]).rows).toEqual([1])
    expect(failureKindRuleFaults([rule({ maxShare: 1.5 })]).rows).toEqual([1])
    expect(failureKindRuleFaults([rule(), rule({ kind: 'timeout', minCount: 0 })]).rows).toEqual([
      2,
    ])
    expect(failureKindRuleFaults([rule({ kind: 'timeout', minCount: 2.5 })]).rows).toEqual([1])
  })

  it('names BOTH rows of a duplicated kind, since either could be the one to fix', () => {
    expect(failureKindRuleFaults([rule(), rule({ maxShare: 0.5 })]).rows).toEqual([1, 2])
  })

  it('reports an over-long list as its own fault, not as a bad row', () => {
    // "There are too many rules" is fixed by deleting any of them, so pointing at a row number
    // would name a row that is perfectly well-formed. The two faults travel separately for that
    // reason, and either one alone must still stop the save.
    const many = Array.from({ length: MAX_FAILURE_KIND_RULES + 1 }, (_, i) =>
      rule({ kind: `kind${i}` }),
    )
    const faults = failureKindRuleFaults(many)
    expect(faults).toEqual({ rows: [], tooMany: true })
    expect(hasFailureKindRuleFaults(faults)).toBe(true)
    // Exactly at the cap is fine — the bound is inclusive, as `v.maxLength` is.
    expect(failureKindRuleFaults(many.slice(0, MAX_FAILURE_KIND_RULES)).tooMany).toBe(false)
  })
})
