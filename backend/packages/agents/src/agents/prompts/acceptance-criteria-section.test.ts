import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_CRITERIA_MAX_PER_FRAME,
  ACCEPTANCE_CRITERIA_PROMPT_MAX_CHARS,
  ACCEPTANCE_CRITERIA_PROMPT_MAX_ENTRIES,
} from '@cat-factory/contracts'
import { acceptanceCriteriaSection } from './standard.js'

// The service's STANDING acceptance criteria as they reach a prompt. The bounding is the part
// worth pinning: this section rides EVERY standard phase, so an unbounded render of a service at
// the store ceiling puts megabytes into each dispatch — and a truncation that doesn't say so reads
// exactly like a complete behavioural contract.

function ctx(criteria?: AgentRunContext['acceptanceCriteria']): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'Build',
    stepIndex: 1,
    isFinalStep: false,
    block: { title: 'Add sign-out', type: 'api', description: 'Sign the user out.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...(criteria ? { acceptanceCriteria: criteria } : {}),
  }
}

const criterion = (i: number, clause = 'something observable follows') => ({
  id: `ac_${i}`,
  title: `Criterion ${i}`,
  given: '',
  when: 'something happens',
  outcome: clause,
  tags: [],
})

describe('acceptanceCriteriaSection', () => {
  it('renders nothing at all when the service has no confirmed criteria', () => {
    // The compatibility promise the whole feature rests on: every prompt byte-for-byte unchanged
    // until a service adopts the store.
    expect(acceptanceCriteriaSection(ctx())).toBe('')
    expect(acceptanceCriteriaSection(ctx({ criteria: [] }))).toBe('')
  })

  it('leads each entry with its stable id and frames the list as standing behaviour', () => {
    const section = acceptanceCriteriaSection(
      ctx({
        criteria: [
          {
            id: 'ac_1',
            title: 'Expired sessions are rejected',
            given: 'a token older than 24 hours',
            when: 'it is presented to an authenticated endpoint',
            outcome: 'the request is rejected with 401',
            tags: ['auth'],
          },
        ],
      }),
    )
    // The id is the join key for the tester's verdicts and the PR report's evidence table.
    expect(section).toContain('- [ac_1] Expired sessions are rejected')
    expect(section).toContain('  - Given: a token older than 24 hours')
    expect(section).toContain('  - Tags: auth')
    // An agent handed a list of behaviours will otherwise read it as a work list.
    expect(section).toContain('NOT a list of work to do in this task')
  })

  it('omits the `Given` line for a criterion that holds unconditionally', () => {
    const section = acceptanceCriteriaSection(ctx({ criteria: [criterion(1)] }))
    expect(section).not.toContain('Given:')
    expect(section).toContain('  - When: something happens')
  })

  it('caps the entry COUNT and says how many it left out', () => {
    const criteria = Array.from({ length: ACCEPTANCE_CRITERIA_PROMPT_MAX_ENTRIES + 7 }, (_, i) =>
      criterion(i),
    )
    const section = acceptanceCriteriaSection(ctx({ criteria }))
    expect(section).toContain(`[ac_${ACCEPTANCE_CRITERIA_PROMPT_MAX_ENTRIES - 1}]`)
    expect(section).not.toContain(`[ac_${ACCEPTANCE_CRITERIA_PROMPT_MAX_ENTRIES}]`)
    expect(section).toContain('7 further confirmed criteria omitted for length')
    expect(section).toContain('this list is NOT complete')
  })

  it('caps the CHARACTER budget too, so long clauses cannot blow up every dispatch', () => {
    // The pathological shape the count cap alone does not bound: few criteria, each at the
    // contract's own 2,000-character clause limit.
    const long = 'x'.repeat(2_000)
    const criteria = Array.from({ length: ACCEPTANCE_CRITERIA_MAX_PER_FRAME }, (_, i) =>
      criterion(i, long),
    )
    const section = acceptanceCriteriaSection(ctx({ criteria }))
    expect(section.length).toBeLessThan(ACCEPTANCE_CRITERIA_PROMPT_MAX_CHARS * 2)
    expect(section).toContain('further confirmed criteria omitted for length')
  })
})
