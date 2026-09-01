import { describe, expect, it } from 'vitest'
import {
  coerceEnvironmentInvestigationVerdict,
  describeRemediationAction,
  environmentRemediationActionSchema,
  isEnvironmentRemediationAction,
  remediationNeedsProviderSupport,
} from './environment-investigation.js'

describe('coerceEnvironmentInvestigationVerdict', () => {
  it('reads a well-formed verdict through unchanged', () => {
    expect(
      coerceEnvironmentInvestigationVerdict({
        faultLayer: 'provider',
        summary: 'The VM behind the environment went offline after the deploy job succeeded.',
        evidence: [{ source: 'provider.describe', statement: 'jobs[0].vm.status = offline' }],
        action: 'recreate',
        actionRationale: 'The instance is dead; re-applying over it would reproduce the fault.',
      }),
    ).toEqual({
      faultLayer: 'provider',
      summary: 'The VM behind the environment went offline after the deploy job succeeded.',
      evidence: [{ source: 'provider.describe', statement: 'jobs[0].vm.status = offline' }],
      action: 'recreate',
      actionRationale: 'The instance is dead; re-applying over it would reproduce the fault.',
    })
  })

  it('returns null for a reply that is not an object, so "unreadable" never reads as "stop"', () => {
    // The distinction the caller depends on: a failed investigation is recorded as failed and the
    // run keeps its own error, where a `stop` verdict REPLACES that error with a finding.
    expect(coerceEnvironmentInvestigationVerdict(null)).toBeNull()
    expect(coerceEnvironmentInvestigationVerdict('stop')).toBeNull()
    expect(coerceEnvironmentInvestigationVerdict([{ action: 'stop' }])).toBeNull()
  })

  it('drops an invented action to `stop` rather than onto a neighbour', () => {
    // The one field where a generous reading spends real infrastructure on a guess.
    const verdict = coerceEnvironmentInvestigationVerdict({
      faultLayer: 'provider',
      summary: 'x',
      action: 'redeploy-everything',
      actionRationale: 'y',
    })
    expect(verdict?.action).toBe('stop')
  })

  it('drops an invented fault layer to `unknown`', () => {
    const verdict = coerceEnvironmentInvestigationVerdict({
      faultLayer: 'the network',
      summary: 'x',
      action: 'stop',
    })
    expect(verdict?.faultLayer).toBe('unknown')
  })

  it('degrades the prose fields one at a time instead of discarding the verdict', () => {
    const verdict = coerceEnvironmentInvestigationVerdict({
      faultLayer: 'platform',
      summary: 'The readiness ceiling expired before the deploy job started.',
      evidence: 'not an array',
      action: 'wait',
    })
    expect(verdict).toMatchObject({
      faultLayer: 'platform',
      action: 'wait',
      evidence: [],
      actionRationale: '',
    })
  })

  it('keeps a usable evidence entry and drops the ones with nothing to say', () => {
    const verdict = coerceEnvironmentInvestigationVerdict({
      faultLayer: 'provider',
      summary: 'x',
      action: 'stop',
      evidence: [
        { source: 'timeline', statement: 'the deploy job started 98s after readiness settled' },
        { source: 'timeline' },
        'a bare string',
        { statement: 'unattributed but real' },
      ],
    })
    expect(verdict?.evidence).toEqual([
      { source: 'timeline', statement: 'the deploy job started 98s after readiness settled' },
      { source: 'unattributed', statement: 'unattributed but real' },
    ])
  })

  it('caps an over-long summary and says so', () => {
    const verdict = coerceEnvironmentInvestigationVerdict({
      faultLayer: 'provider',
      summary: 'x'.repeat(5000),
      action: 'stop',
    })
    expect(verdict?.summary).toHaveLength(4001)
    expect(verdict?.summary.endsWith('…')).toBe(true)
  })
})

describe('the remediation vocabulary', () => {
  it('needs provider support for exactly the actions the provider performs', () => {
    // A RELATION over the vocabulary rather than a pinned count: the actions the platform owns
    // outright (waiting, standing up again, tearing down) are `EnvironmentProvider` methods every
    // provider already has, so only the in-place restart may depend on the optional capability.
    const needing = environmentRemediationActionSchema.options.filter((action) =>
      remediationNeedsProviderSupport(action),
    )
    expect(needing).toEqual(['restart'])
  })

  it('describes every member of the vocabulary', () => {
    for (const action of environmentRemediationActionSchema.options) {
      expect(describeRemediationAction(action)).not.toContain('no longer offers')
      expect(describeRemediationAction(action).length).toBeGreaterThan(0)
    }
  })

  it('names a RETIRED action as retired instead of guessing a current one', () => {
    // The persisted-closed-vocabulary rule: a value dropped from the picklist is still in the
    // database, and the reader that hits it first is the message telling a human what to re-pick.
    expect(isEnvironmentRemediationAction('rebuild-cluster')).toBe(false)
    expect(describeRemediationAction('rebuild-cluster')).toContain('no longer offers')
    expect(describeRemediationAction('rebuild-cluster')).toContain('rebuild-cluster')
  })

  it('refuses an absent action rather than narrowing it', () => {
    expect(isEnvironmentRemediationAction(undefined)).toBe(false)
    expect(isEnvironmentRemediationAction(null)).toBe(false)
    expect(isEnvironmentRemediationAction('')).toBe(false)
  })
})
