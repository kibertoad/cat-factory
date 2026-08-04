import { describe, expect, it } from 'vitest'
import type { PlatformFailureKindRule } from '~/types/execution'
import {
  AGENT_FAILURE_KINDS,
  FAILURE_KIND_KEYS,
  invalidFailureKindRuleRows,
  isKnownFailureKind,
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
    expect(isKnownFailureKind('evicted')).toBe(true)
    // The case the predicate exists for: a kind that a release retired still arrives on stored
    // rules and old run rows, and must render as itself rather than as `undefined` or as
    // whichever current member a guess landed on.
    expect(isKnownFailureKind('evicetd')).toBe(false)
  })
})

describe('invalidFailureKindRuleRows', () => {
  const rule = (over: Partial<PlatformFailureKindRule> = {}): PlatformFailureKindRule => ({
    kind: 'evicted',
    maxShare: 0.05,
    ...over,
  })

  it('accepts a well-formed set of rules', () => {
    expect(
      invalidFailureKindRuleRows([rule(), rule({ kind: 'timeout', maxShare: 1, minCount: 3 })]),
    ).toEqual([])
    expect(invalidFailureKindRuleRows([])).toEqual([])
  })

  it('names the 1-based rows the backend would refuse', () => {
    // The share bounds mirror the contract: 0 is satisfied by any distribution (including a kind
    // that never occurred), and there is nothing above "all of them".
    expect(invalidFailureKindRuleRows([rule({ maxShare: 0 })])).toEqual([1])
    expect(invalidFailureKindRuleRows([rule({ maxShare: 1.5 })])).toEqual([1])
    expect(invalidFailureKindRuleRows([rule(), rule({ kind: 'timeout', minCount: 0 })])).toEqual([
      2,
    ])
    expect(invalidFailureKindRuleRows([rule({ kind: 'timeout', minCount: 2.5 })])).toEqual([1])
  })

  it('names BOTH rows of a duplicated kind, since either could be the one to fix', () => {
    expect(invalidFailureKindRuleRows([rule(), rule({ maxShare: 0.5 })])).toEqual([1, 2])
  })
})
