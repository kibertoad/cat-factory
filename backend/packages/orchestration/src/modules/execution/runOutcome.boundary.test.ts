import type { RunOutcome } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { boundOutcomeForApi } from './runOutcome.boundary.js'

// `composeRunOutcome` is shared with the SPA and deliberately hands back what the producers
// wrote. What crosses the wire to an API key is a different exposure, and these pin the two
// things that treatment owes: nothing a producer echoed into its prose leaves verbatim, and
// nothing a producer wrote at length leaves unbounded WITHOUT SAYING SO.

const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'

function outcome(partial: Partial<RunOutcome> = {}): RunOutcome {
  return {
    version: 1,
    disposition: 'awaiting_merge',
    title: 'Add login',
    ask: null,
    pullRequests: [],
    requirements: { status: 'absent', gap: 'no_tester_step' },
    tests: { status: 'absent', gap: 'no_tester_step' },
    visuals: { status: 'absent', gap: 'no_visual_step', detail: null },
    environments: { status: 'absent', gap: 'no_environment_step' },
    sources: { status: 'absent', gap: 'none_linked' },
    checks: [],
    truncations: [],
    ...partial,
  }
}

function requirement(
  id: string,
  detail: string | null = null,
): {
  id: string
  title: string | null
  verdict: 'met'
  detail: string | null
  state: null
  regression: false
} {
  return { id, title: `Requirement ${id}`, verdict: 'met', detail, state: null, regression: false }
}

describe('boundOutcomeForApi', () => {
  it('scrubs a credential the tester echoed into its evidence', () => {
    const bounded = boundOutcomeForApi(
      outcome({
        requirements: {
          status: 'reported',
          spec: 'joined',
          met: 1,
          notMet: 0,
          notCovered: 0,
          regressions: 0,
          total: 1,
          unmatchedVerdicts: 0,
          entries: [requirement('req-a', `called the API with ${SECRET}`)],
        },
      }),
    )
    if (bounded.requirements.status !== 'reported') throw new Error('expected coverage')
    expect(bounded.requirements.entries[0]!.detail).not.toContain(SECRET)
  })

  it('scrubs the tester’s session prose and its abort reason', () => {
    const bounded = boundOutcomeForApi(
      outcome({
        tests: {
          status: 'reported',
          verdict: 'could_not_run',
          summary: `auth failed for ${SECRET}`,
          abortReason: `no session: ${SECRET}`,
          areas: [],
          passed: 0,
          failed: 0,
          skipped: 0,
          concerns: [],
          environment: null,
        },
      }),
    )
    if (bounded.tests.status !== 'reported') throw new Error('expected a report')
    expect(bounded.tests.summary).not.toContain(SECRET)
    expect(bounded.tests.abortReason).not.toContain(SECRET)
  })

  // The environment URL comes from the org's own provisioning API through the manifest's
  // response mapping, so it is provider-supplied text like any other, and the detail beside it is
  // a provider's verbatim stderr.
  it('scrubs the environment URL and the provider’s cause', () => {
    const bounded = boundOutcomeForApi(
      outcome({
        environments: {
          status: 'reported',
          entries: [
            {
              url: `https://preview.test/?token=${SECRET}`,
              state: 'failed',
              origin: 'deployer',
              expiresAt: null,
              retained: false,
              frameId: 'frm_own',
              environmentId: 'env_1',
              detail: `provision refused: ${SECRET}`,
              detailKind: 'fault',
            },
          ],
        },
      }),
    )
    if (bounded.environments.status !== 'reported') throw new Error('expected environments')
    expect(bounded.environments.entries[0]!.url).not.toContain(SECRET)
    expect(bounded.environments.entries[0]!.detail).not.toContain(SECRET)
    // The label rides through with the text it labels: scrubbed prose in an unlabelled slot is
    // exactly the misreading the kind exists to prevent.
    expect(bounded.environments.entries[0]!.detailKind).toBe('fault')
  })

  it('leaves an ordinary payload byte-for-byte alone', () => {
    const plain = outcome({ ask: 'Let a user sign in.', title: 'Add login' })
    expect(boundOutcomeForApi(plain)).toEqual(plain)
  })

  it('bounds a pathological row count and SAYS what it dropped', () => {
    const entries = Array.from({ length: 640 }, (_, i) => requirement(`req-${i}`))
    const bounded = boundOutcomeForApi(
      outcome({
        requirements: {
          status: 'reported',
          spec: 'joined',
          met: 640,
          notMet: 0,
          notCovered: 0,
          regressions: 0,
          total: 640,
          unmatchedVerdicts: 0,
          entries,
        },
      }),
    )
    if (bounded.requirements.status !== 'reported') throw new Error('expected coverage')
    expect(bounded.requirements.entries).toHaveLength(500)
    // The COUNTS are over the whole join and must survive the cap untouched: a bounded rendering
    // that also shrank its totals would report a smaller spec rather than a shorter table.
    expect(bounded.requirements.total).toBe(640)
    expect(bounded.requirements.met).toBe(640)
    expect(bounded.truncations).toEqual([
      'requirements.entries: showing 500 of 640 (ordered by severity, so the rows dropped are the least severe)',
    ])
  })

  it('clamps one runaway field rather than the whole payload', () => {
    const bounded = boundOutcomeForApi(outcome({ ask: 'x'.repeat(9_000) }))
    expect(bounded.ask).toHaveLength(2_000)
    expect(bounded.ask?.endsWith('…')).toBe(true)
    // A clamp is not a cap: it changes one field, so it owes no truncation note of its own.
    expect(bounded.truncations).toEqual([])
  })

  it('scrubs BEFORE clamping, so a cut cannot leave half a credential behind', () => {
    // The credential sits past the clamp point: clamping first would drop it, which would pass
    // a naive "not toContain" assertion while the same secret in a SHORTER field survived.
    const bounded = boundOutcomeForApi(outcome({ ask: `${'x'.repeat(1_990)}${SECRET} tail` }))
    expect(bounded.ask).not.toContain(SECRET)
    expect(bounded.ask).not.toContain(SECRET.slice(0, 12))
  })
})
