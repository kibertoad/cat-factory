import { describe, expect, it } from 'vitest'
import { projectStageIssues, projectStageSchema } from './project-stages.js'
import { computeStageAcceptance, unassessedStageAcceptance } from './stage-acceptance.js'
import * as v from 'valibot'

const criteria = [
  { id: 'auth', statement: 'The auth scheme is named.' },
  { id: 'paging', statement: 'Pagination is described.' },
  { id: 'limits', statement: 'Rate limits are known.' },
  { id: 'errors', statement: 'Error codes are listed.' },
]

const result = 'The API uses OAuth client credentials.\n\nPages are cursor based, 100 items each.'

describe('computeStageAcceptance', () => {
  it('computes each status from the claim and whether the result holds every quote', () => {
    const report = computeStageAcceptance({
      outcomeId: 'pout_1',
      assessedAt: 5,
      model: 'fake:model',
      criteria,
      result,
      reply: {
        criteria: [
          {
            id: 'auth',
            claim: 'met',
            rationale: 'Named.',
            evidence: ['uses  OAUTH client credentials'],
          },
          {
            id: 'paging',
            claim: 'met',
            rationale: 'Guessed.',
            evidence: ['Pages are offset based'],
          },
          { id: 'limits', claim: 'unmet', rationale: 'Not covered.', evidence: [] },
          { id: 'invented', claim: 'met', evidence: ['anything at all here'] },
        ],
      },
    })
    expect(report.state).toBe('assessed')
    expect(report.criteria.map((c) => [c.id, c.status])).toEqual([
      ['auth', 'met'],
      ['paging', 'unverified'],
      ['limits', 'unmet'],
      ['errors', 'unverified'],
    ])
    expect(report.criteria[1]!.unfound).toEqual(['Pages are offset based'])
    expect(report.criteria[3]!.claim).toBeNull()
  })

  it('does not count a passage too short to prove anything', () => {
    const report = computeStageAcceptance({
      outcomeId: 'pout_1',
      assessedAt: 5,
      model: 'fake:model',
      criteria: [criteria[0]!],
      result,
      reply: { criteria: [{ id: 'auth', claim: 'met', evidence: ['OAuth'] }] },
    })
    expect(report.criteria[0]!.status).toBe('unverified')
  })

  it('states an assessment that did not happen, every criterion unverified', () => {
    const report = unassessedStageAcceptance({
      outcomeId: 'pout_1',
      assessedAt: 5,
      criteria,
      state: 'unavailable',
      note: 'No model is configured.',
    })
    expect(report.criteria.every((c) => c.status === 'unverified')).toBe(true)
    expect(report.note).toBe('No model is configured.')
  })
})

describe('stage acceptance criteria', () => {
  it('needs a checkpoint and unique criterion ids', () => {
    const stage = (over: Record<string, unknown>) =>
      v.parse(projectStageSchema, {
        id: 'discover',
        title: 'Discover',
        taskType: 'research',
        produces: 'discovery',
        acceptance: [criteria[0]],
        ...over,
      })
    expect(projectStageIssues([stage({})])).toEqual([
      "stage 'discover' declares acceptance criteria, so it must declare a checkpoint where a person reads the report",
    ])
    expect(projectStageIssues([stage({ checkpoint: true })])).toEqual([])
    expect(() => stage({ acceptance: [criteria[0], criteria[0]] })).toThrow(/unique/)
  })
})
