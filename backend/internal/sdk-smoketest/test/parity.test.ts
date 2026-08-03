// The comparator is the whole point of this harness, so it gets its own tests: a bug HERE is
// silent by construction — it reports green while the four SDKs disagree, which is the exact
// failure the harness exists to prevent.

import { describe, expect, it } from 'vitest'
import { compareReports, type SdkReport } from '../src/parity.ts'

/** A report that satisfies every absolute expectation, so a test can vary one thing at a time. */
function goodReport(sdk: string, overrides: Record<string, unknown> = {}): SdkReport {
  return {
    sdk,
    sdkVersion: '0.1.0',
    failures: [],
    observations: {
      firstServiceHasId: true,
      createdStatus: 'planned',
      createdTaskType: 'feature',
      createdExecutionIdIsNull: true,
      createdPullRequestUrlIsNull: true,
      updatedTitle: 'SDK smoketest task (edited)',
      fetchedTitle: 'SDK smoketest task (edited)',
      pageSize: 1,
      pagedContainsCreated: true,
      pagedHasDuplicates: false,
      usageRowsIsArray: true,
      notFoundIsTypedClass: true,
      notFoundStatus: 404,
      notFoundCode: 'not_found',
      notFoundHasRequestId: true,
      unauthorizedIsTypedClass: true,
      unauthorizedStatus: 401,
      forbiddenIsTypedClass: true,
      forbiddenStatus: 403,
      forbiddenCode: 'insufficient_scope',
      startedHasExecutionId: true,
      sseFramesAreKnown: true,
      runStatusIsKnown: true,
      deletedThenGone: true,
      // Not in EXPECTED, so it is compared ACROSS the SDKs instead.
      usageCurrency: 'USD',
      ...overrides,
    },
  }
}

describe('compareReports', () => {
  it('reports nothing when every SDK agrees and satisfies the expectations', () => {
    const problems = compareReports([goodReport('typescript'), goodReport('go')])
    expect(problems).toEqual([])
  })

  it('surfaces a step failure a single SDK recorded', () => {
    const broken = goodReport('python')
    broken.failures = ['tasks.create: 500 internal']
    const problems = compareReports([goodReport('typescript'), broken])
    expect(problems).toEqual([{ kind: 'failure', detail: '[python] tasks.create: 500 internal' }])
  })

  it('catches an SDK that mapped a refusal to the wrong code', () => {
    // The case this whole harness exists for: a client that flattens the surface-specific
    // `insufficient_scope` to its status class would still "work", and only a comparison sees it.
    const problems = compareReports([
      goodReport('typescript'),
      goodReport('java', { forbiddenCode: 'forbidden' }),
    ])
    expect(problems).toEqual([
      {
        kind: 'expectation',
        detail: '[java] \'forbiddenCode\' is "forbidden", expected "insufficient_scope"',
      },
    ])
  })

  it('catches all SDKs being wrong the same way', () => {
    // A pure disagreement check cannot see this — they agree with each other perfectly.
    const problems = compareReports([
      goodReport('typescript', { notFoundStatus: 500 }),
      goodReport('go', { notFoundStatus: 500 }),
    ])
    expect(problems).toHaveLength(2)
    expect(problems.every((p) => p.kind === 'expectation')).toBe(true)
  })

  it('reports a disagreement on an observation with no absolute expectation', () => {
    const problems = compareReports([
      goodReport('typescript'),
      goodReport('python', { usageCurrency: 'EUR' }),
    ])
    expect(problems).toEqual([
      {
        kind: 'disagreement',
        detail: '\'usageCurrency\' differs across SDKs: typescript="USD", python="EUR"',
      },
    ])
  })

  it('reports an observation some SDKs recorded and others did not', () => {
    // A step that threw in one SDK leaves its key absent. Comparing over the UNION of keys is
    // what turns that into a reported problem rather than a silently narrower comparison.
    const partial = goodReport('go')
    delete partial.observations.usageCurrency
    const problems = compareReports([goodReport('typescript'), partial])
    expect(problems).toEqual([
      {
        kind: 'missing',
        detail: "'usageCurrency' was observed by 1/2 SDKs; go did not record it",
      },
    ])
  })

  it('ignores observations that are legitimately environmental', () => {
    // How far a run had progressed when each client looked is timing, not behaviour.
    const problems = compareReports([
      goodReport('typescript', { sseEventCount: 1, pagedTaskCount: 7 }),
      goodReport('go', { sseEventCount: 3, pagedTaskCount: 9 }),
    ])
    expect(problems).toEqual([])
  })

  it('does not treat a numeric type difference as a divergence', () => {
    // Python's float-typed model fields can surface 1.0 where Go writes 1. Comparing numerically
    // rather than by JSON text keeps that from reading as a behavioural difference.
    const problems = compareReports([
      goodReport('go', { pageSize: 1 }),
      goodReport('python', { pageSize: 1.0 }),
    ])
    expect(problems).toEqual([])
  })
})
