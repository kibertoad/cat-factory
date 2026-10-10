import { describe, expect, it } from 'vitest'
import {
  coerceEnvironmentProbeReport,
  environmentProbeSurfaceFor,
  isEnvironmentProbeReportPayload,
  summarizeEnvironmentProbe,
  type EnvironmentProbeOperation,
} from './environment-probe.js'

// The PLATFORM's half of the agent dry run's report: the tallies and the verdict it derives from
// the model's per-operation judgements, and the coercion that stands between a model's reply and
// the persisted row.
//
// The verdict cases are the point of the feature rather than a rounding-out of coverage: the whole
// reason a dry run exists is that a healthcheck answering 200 tells nobody whether an agent can
// work in an environment, so `operable` has to be unreachable without an authenticated success.

function op(over: Partial<EnvironmentProbeOperation> = {}): EnvironmentProbeOperation {
  return { name: 'do a thing', authenticated: true, outcome: 'succeeded', ...over }
}

describe('summarizeEnvironmentProbe', () => {
  it('grades everything-worked-including-auth as operable', () => {
    const result = summarizeEnvironmentProbe([
      op({ name: 'healthcheck', authenticated: false }),
      op({ name: 'list projects' }),
    ])
    expect(result).toEqual({
      attempted: 2,
      succeeded: 2,
      authenticatedSucceeded: 1,
      verdict: 'operable',
    })
  })

  it('refuses `operable` when nothing that worked went through authentication', () => {
    // The case the feature exists for: the ingress answers, so a naive reading is "all green",
    // and the run would have told an operator their environment was ready for an agent that
    // cannot in fact authenticate against it.
    const result = summarizeEnvironmentProbe([
      op({ name: 'healthcheck', authenticated: false }),
      op({ name: 'version', authenticated: false }),
    ])
    expect(result.succeeded).toBe(2)
    expect(result.authenticatedSucceeded).toBe(0)
    expect(result.verdict).toBe('partially_operable')
  })

  it('grades a mixed run as partially operable', () => {
    const result = summarizeEnvironmentProbe([
      op({ name: 'list' }),
      op({ name: 'create', outcome: 'failed', failure: 'auth_rejected' }),
    ])
    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      authenticatedSucceeded: 1,
      verdict: 'partially_operable',
    })
  })

  it('grades nothing-worked as inoperable, and never counts an unattempted operation as tried', () => {
    // `not_attempted` is a FINDING, not a failed call: counting it as attempted would make "the
    // agent could not work out what to call" read as "everything was tried and the service
    // refused it", which is a different bug report entirely.
    const result = summarizeEnvironmentProbe([
      op({ name: 'list', outcome: 'failed', failure: 'unreachable' }),
      op({ name: 'create', outcome: 'not_attempted', failure: 'endpoint_unknown' }),
    ])
    expect(result).toEqual({
      attempted: 1,
      succeeded: 0,
      authenticatedSucceeded: 0,
      verdict: 'inoperable',
    })
  })

  it('refuses `operable` when the agent listed operations it could not even attempt', () => {
    // The exact shape this diagnostic exists to surface: one authenticated success beside four
    // things the agent could not work out how to try. Graded on the ATTEMPTED ones alone it reads
    // `operable`, and the inspector then renders "an agent can operate this service" in green
    // directly above the list of what it could not do.
    const result = summarizeEnvironmentProbe([
      op({ name: 'list projects' }),
      op({ name: 'create a project', outcome: 'not_attempted', failure: 'endpoint_unknown' }),
      op({ name: 'sign in', outcome: 'not_attempted', failure: 'auth_missing' }),
    ])
    expect(result.attempted).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.authenticatedSucceeded).toBe(1)
    expect(result.verdict).toBe('partially_operable')
  })

  it('grades an empty attempt as inoperable', () => {
    expect(summarizeEnvironmentProbe([]).verdict).toBe('inoperable')
  })
})

describe('coerceEnvironmentProbeReport', () => {
  it('keeps a well-formed report and computes the tallies itself', () => {
    const report = coerceEnvironmentProbeReport(
      {
        summary: 'Listed projects; creating one was refused.',
        operations: [
          {
            name: 'list projects',
            target: 'GET /projects',
            authenticated: true,
            outcome: 'succeeded',
            detail: '200',
          },
          {
            name: 'create a project',
            authenticated: true,
            outcome: 'failed',
            failure: 'auth_rejected',
            detail: '403',
          },
        ],
        missingContext: ['no write-scoped credential was supplied'],
        blockers: [],
      },
      { surface: 'api', model: 'workers-ai:qwen' },
    )
    expect(report.verdict).toBe('partially_operable')
    expect(report.attempted).toBe(2)
    expect(report.succeeded).toBe(1)
    expect(report.authenticatedSucceeded).toBe(1)
    expect(report.operations[0]?.target).toBe('GET /projects')
    expect(report.missingContext).toEqual(['no write-scoped credential was supplied'])
    expect(report.model).toBe('workers-ai:qwen')
    expect(report.operationsOmitted).toBeUndefined()
  })

  it('takes the surface from the CALLER, never from the reply', () => {
    // The platform chose which prober to dispatch, so a model claiming the other one would be
    // reporting about a run that did not happen.
    const report = coerceEnvironmentProbeReport(
      { surface: 'api', operations: [] },
      { surface: 'ui' },
    )
    expect(report.surface).toBe('ui')
  })

  it('degrades a malformed reply field by field instead of discarding the report', () => {
    const report = coerceEnvironmentProbeReport(
      {
        summary: 42,
        operations: [
          // Unnamed: nothing to render or act on, so dropped (and counted as dropped).
          { authenticated: true, outcome: 'succeeded' },
          // No outcome stated: `not_attempted` is the honest reading, since `failed` would
          // attribute a fault the agent never claimed.
          { name: 'list projects' },
          // A failure kind this build does not know still has to say whose problem it was.
          { name: 'create', outcome: 'failed', failure: 'quantum_flux' },
        ],
        missingContext: [{ not: 'a string' }, 'a real one'],
        blockers: [{ kind: 'nonsense' }, { kind: 'unreachable', detail: 'connection refused' }],
      },
      { surface: 'api' },
    )
    expect(report.summary).toBe('')
    expect(report.operations.map((o) => o.name)).toEqual(['list projects', 'create'])
    expect(report.operations[0]?.outcome).toBe('not_attempted')
    expect(report.operations[0]?.failure).toBe('other')
    expect(report.operations[1]?.failure).toBe('other')
    // The dropped operation is RECORDED, and as UNREADABLE rather than as a cap drop: the two
    // send a reader somewhere different, and "dropped at the cap" would claim the agent reported
    // more operations than it did.
    expect(report.operationsOmitted).toBeUndefined()
    expect(report.operationsUnreadable).toBe(1)
    expect(report.missingContext).toEqual(['a real one'])
    // A blocker with no detail carries nothing a human can act on; one with an unknown kind does.
    expect(report.blockers).toEqual([{ kind: 'unreachable', detail: 'connection refused' }])
    expect(report.verdict).toBe('inoperable')
  })

  it('reads a reply that is not an object at all as an empty, inoperable report', () => {
    const report = coerceEnvironmentProbeReport('the environment seemed fine', { surface: 'api' })
    expect(report.operations).toEqual([])
    expect(report.verdict).toBe('inoperable')
    expect(report.summary).toBe('')
  })

  it('caps the operation list and records how many it dropped', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `op ${i}`,
      authenticated: true,
      outcome: 'succeeded',
    }))
    const report = coerceEnvironmentProbeReport({ operations: many }, { surface: 'api' })
    expect(report.operations.length).toBe(12)
    expect(report.operationsOmitted).toBe(8)
    expect(report.operationsUnreadable).toBeUndefined()
    // The tallies describe what the report HOLDS, not what the reply claimed: a count over
    // dropped entries would be a number nothing in the report accounts for.
    expect(report.attempted).toBe(12)
  })

  it('counts a cap drop and an unreadable entry apart, in the run that has both', () => {
    const operations = [
      ...Array.from({ length: 13 }, (_, i) => ({
        name: `op ${i}`,
        authenticated: true,
        outcome: 'succeeded',
      })),
      { authenticated: true, outcome: 'succeeded' },
    ]
    // The unnamed entry is INSIDE the cap (it is the 14th of 14, but the cap takes the first 12),
    // so this run drops 2 at the cap and 0 for being unreadable.
    const report = coerceEnvironmentProbeReport({ operations }, { surface: 'api' })
    expect(report.operations.length).toBe(12)
    expect(report.operationsOmitted).toBe(2)
    expect(report.operationsUnreadable).toBeUndefined()

    // Move the unnamed entry inside the cap and the split flips.
    const mixed = coerceEnvironmentProbeReport(
      { operations: [{ authenticated: true, outcome: 'succeeded' }, ...operations.slice(0, 13)] },
      { surface: 'api' },
    )
    expect(mixed.operations.length).toBe(11)
    expect(mixed.operationsOmitted).toBe(2)
    expect(mixed.operationsUnreadable).toBe(1)
  })

  it('SCRUBS the caller-supplied way, before any cap can split a credential', () => {
    // The prompt hands the agent the environment's own bearer token, so a model that pastes its
    // own `curl` invocation into a `detail` writes that credential into a persisted row and a
    // rendered panel. The scrub runs on the whole value first: applied after the cap it could
    // leave the head of a token inside the kept prefix.
    const report = coerceEnvironmentProbeReport(
      {
        summary: 'called with Authorization: Bearer supersecrettokenvalue',
        operations: [
          {
            name: 'list projects',
            authenticated: true,
            outcome: 'succeeded',
            detail: 'curl -H "Authorization: Bearer supersecrettokenvalue"',
          },
        ],
        missingContext: ['token supersecrettokenvalue had no write scope'],
        blockers: [{ kind: 'other', detail: 'Bearer supersecrettokenvalue was refused' }],
      },
      { surface: 'api', scrub: (value) => value.replaceAll('supersecrettokenvalue', '[redacted]') },
    )
    expect(JSON.stringify(report)).not.toContain('supersecrettokenvalue')
    expect(report.operations[0]?.detail).toContain('[redacted]')
    expect(report.missingContext[0]).toContain('[redacted]')
    expect(report.blockers[0]?.detail).toContain('[redacted]')
    expect(report.summary).toContain('[redacted]')
  })

  it('marks a truncated string rather than silently shortening it', () => {
    const report = coerceEnvironmentProbeReport(
      { operations: [{ name: 'x'.repeat(400), authenticated: false, outcome: 'succeeded' }] },
      { surface: 'api' },
    )
    expect(report.operations[0]?.name.endsWith('[truncated]')).toBe(true)
  })
})

describe('environmentProbeSurfaceFor', () => {
  it('drives a frontend frame in a browser and everything else over its protocol', () => {
    expect(environmentProbeSurfaceFor('frontend')).toBe('ui')
    for (const type of ['service', 'api', 'database', 'queue', 'integration'] as const) {
      expect(environmentProbeSurfaceFor(type)).toBe('api')
    }
  })
})

describe('isEnvironmentProbeReportPayload', () => {
  it('accepts only what the coercion can read something out of', () => {
    // The DISPATCHER asks this before calling the coercion, because everything rejected here
    // coerces to an empty report the platform then grades `inoperable`: a finding about the
    // service, invented out of a reply that established nothing. Two callers, one predicate.
    expect(isEnvironmentProbeReportPayload({ summary: 'ok' })).toBe(true)
    expect(isEnvironmentProbeReportPayload({})).toBe(true)
    for (const value of [null, undefined, [], [{ name: 'x' }], 'text', 42, true]) {
      expect(isEnvironmentProbeReportPayload(value)).toBe(false)
    }
  })
})
