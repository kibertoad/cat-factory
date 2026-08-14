import type { PrVerificationReport } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import {
  assertChecks,
  check,
  checkCi,
  checkEphemeralEnvironment,
  checkMergeDecision,
  checkNotTruncated,
  checkReproductionProof,
  retainedEnvironmentUrl,
} from './evidence.js'

// These reductions decide whether an acceptance run passes, so a bug in one reports green and
// nothing else notices: the same reason the SDK smoketest unit-tests its own grader. What is
// pinned here is that each reduction FAILS on the shapes the platform uses to say "this did not
// happen", since those are the ones a naive `status === 'reported'` check would wave through.

/** A minimal report with every section absent; scenarios override the one section under test. */
function report(overrides: Partial<PrVerificationReport> = {}): PrVerificationReport {
  return {
    version: 7,
    generatedAt: 0,
    run: {} as PrVerificationReport['run'],
    context: {} as PrVerificationReport['context'],
    ci: { status: 'absent', failingChecks: [], fixerAttempts: 0 },
    validation: {} as PrVerificationReport['validation'],
    reproduction: { status: 'absent', testPaths: [], attempts: 0 },
    tests: {} as PrVerificationReport['tests'],
    requirements: {} as PrVerificationReport['requirements'],
    environments: {
      status: 'absent',
      entries: [],
      teardown: 'not_applicable',
      timeline: {} as PrVerificationReport['environments']['timeline'],
      evidence: {} as PrVerificationReport['environments']['evidence'],
      proof: 'not_applicable',
      gaps: [],
    },
    merge: { status: 'absent' },
    judges: {} as PrVerificationReport['judges'],
    observability: {} as PrVerificationReport['observability'],
    truncations: [],
    ...overrides,
  }
}

const failed = (checks: ReturnType<typeof checkCi>) => checks.filter((entry) => !entry.ok)

describe('checkEphemeralEnvironment', () => {
  it('fails a run where no environment was ever stood up', () => {
    expect(failed(checkEphemeralEnvironment(report())).length).toBeGreaterThan(0)
  })

  it('fails a `not_applicable` proof, which is a fact about the PIPELINE, not a pass', () => {
    // The trap this pins: a pipeline with no deployer reports `not_applicable`, and a check
    // written as `proof !== 'incomplete'` would grade that as success and quietly stop testing
    // the k3s wiring the moment someone edited the preset.
    const checks = checkEphemeralEnvironment(
      report({
        environments: {
          ...report().environments,
          status: 'reported',
          proof: 'not_applicable',
          entries: [{ frameId: 'blk_1', status: 'skipped' }],
        },
      }),
    )
    expect(failed(checks).length).toBeGreaterThan(0)
  })

  it('fails a `retained` teardown even though the proof is complete', () => {
    // `complete` deliberately includes an environment the deployer declared outlives the run, so
    // the teardown leg has to be asserted separately or this suite leaks namespaces on a
    // developer's cluster while reporting green.
    const checks = checkEphemeralEnvironment(
      report({
        environments: {
          ...report().environments,
          status: 'reported',
          proof: 'complete',
          teardown: 'retained',
          entries: [{ frameId: 'blk_1', status: 'ready', url: 'http://x.nip.io' }],
        },
      }),
    )
    expect(
      failed(checks)
        .map((entry) => entry.claim)
        .join(),
    ).toContain('reclaimed')
  })

  it('passes a run that came up, proved complete and was reclaimed', () => {
    const checks = checkEphemeralEnvironment(
      report({
        environments: {
          ...report().environments,
          status: 'reported',
          proof: 'complete',
          teardown: 'confirmed',
          entries: [{ frameId: 'blk_1', status: 'ready', url: 'http://cf-acc-1.127.0.0.1.nip.io' }],
        },
      }),
    )
    expect(failed(checks)).toEqual([])
  })
})

describe('checkReproductionProof', () => {
  it("fails `declared_infeasible` and carries the agent's stated reason into the message", () => {
    const checks = checkReproductionProof(
      report({
        reproduction: {
          status: 'reported',
          verdict: 'declared_infeasible',
          reason: 'the defect needs two services running together',
          testPaths: [],
          attempts: 1,
        },
      }),
    )
    const verdict = checks.find((entry) => entry.claim.includes('verdict'))
    expect(verdict?.ok).toBe(false)
    // A concede is an honest outcome the platform is designed to report; flattening it to "no
    // proof" would throw away the only sentence explaining why.
    expect(verdict?.detail).toContain('two services')
  })

  it('fails a proof whose pre-fix tree PASSED, since the defect was then never demonstrated', () => {
    const checks = checkReproductionProof(
      report({
        reproduction: {
          status: 'reported',
          verdict: 'reproduced',
          base: { passed: true, exitCode: 0 },
          final: { passed: true, exitCode: 0 },
          testPaths: ['test/paging.test.ts'],
          attempts: 1,
        },
      }),
    )
    expect(
      failed(checks)
        .map((entry) => entry.claim)
        .join(),
    ).toContain('pre-fix')
  })

  it('fails when declared reproduction paths were dropped before the proof ran', () => {
    // A dropped path can green the pre-fix tree, which reads as "the test does not capture the
    // defect", so the platform states it and this reduction must not ignore it.
    const checks = checkReproductionProof(
      report({
        reproduction: {
          status: 'reported',
          verdict: 'reproduced',
          base: { passed: false, exitCode: 1 },
          final: { passed: true, exitCode: 0 },
          omittedTestPaths: 2,
          testPaths: ['test/paging.test.ts'],
          attempts: 1,
        },
      }),
    )
    expect(
      failed(checks)
        .map((entry) => entry.claim)
        .join(),
    ).toContain('dropped')
  })

  it('passes a genuine red-then-green proof', () => {
    const checks = checkReproductionProof(
      report({
        reproduction: {
          status: 'reported',
          verdict: 'reproduced',
          command: 'npm test -- test/paging.test.ts',
          base: { passed: false, exitCode: 1 },
          final: { passed: true, exitCode: 0 },
          omittedTestPaths: 0,
          testPaths: ['test/paging.test.ts'],
          attempts: 1,
        },
      }),
    )
    expect(failed(checks)).toEqual([])
  })
})

describe('checkCi and checkMergeDecision', () => {
  it('fails a pending CI verdict rather than treating "not red" as green', () => {
    const checks = checkCi(
      report({
        ci: { status: 'reported', verdict: 'pending', failingChecks: [], fixerAttempts: 0 },
      }),
    )
    expect(failed(checks).length).toBe(1)
  })

  it('fails a merger that produced an assessment but no resolved outcome', () => {
    const checks = checkMergeDecision(report({ merge: { status: 'reported' } }))
    expect(
      failed(checks)
        .map((entry) => entry.claim)
        .join(),
    ).toContain('outcome')
  })

  it('passes a merge that was resolved, whatever the outcome was', () => {
    // Deliberately not "merged": whether it merges is the workspace's merge preset talking, and a
    // deployment that holds everything for a person is correctly configured, not broken.
    const checks = checkMergeDecision(
      report({ merge: { status: 'reported', outcome: 'held_for_review', presetName: 'Cautious' } }),
    )
    expect(failed(checks)).toEqual([])
  })
})

describe('checkNotTruncated', () => {
  it('fails a capped report, because the checks above read lists off it', () => {
    const entry = checkNotTruncated(report({ truncations: ['tests.outcomes: showing 50 of 118'] }))
    expect(entry.ok).toBe(false)
    expect(entry.detail).toContain('118')
  })
})

describe('assertChecks', () => {
  it('reports EVERY failed claim, not just the first', () => {
    let message = ''
    try {
      assertChecks('a run', [
        check('the environment came up', false, 'none ready'),
        check('CI passed', false, 'verdict=fail'),
        check('the report is whole', true, 'no truncations'),
      ])
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('2 of 3')
    expect(message).toContain('none ready')
    expect(message).toContain('verdict=fail')
    // Passing claims are shown too: on a long unattended run, knowing what DID hold is most of
    // the diagnosis.
    expect(message).toContain('no truncations')
  })

  it('says nothing when every claim holds', () => {
    expect(() => assertChecks('a run', [check('ok', true, 'fine')])).not.toThrow()
  })
})

describe('retainedEnvironmentUrl', () => {
  const withEnvironments = (
    teardown: PrVerificationReport['environments']['teardown'],
    entries: PrVerificationReport['environments']['entries'],
  ) => report({ environments: { ...report().environments, status: 'reported', teardown, entries } })

  it('withholds the URL of an environment the run reclaimed', () => {
    // The trap: a settled report keeps saying `ready`, because that is what the entry was at
    // DEPLOY time. Reading it as a live address puts a dead host in front of an investigator,
    // who then concludes the reporter's environment is the fault and stops looking.
    const url = retainedEnvironmentUrl(
      withEnvironments('confirmed', [
        { frameId: 'blk_1', status: 'ready', url: 'http://cf-acc-1.127.0.0.1.nip.io' },
      ]),
    )
    expect(url).toBeNull()
  })

  it('withholds it when the reclaim never settled, which is not the same as retained', () => {
    for (const teardown of ['unconfirmed', 'pending', 'failed', 'not_applicable'] as const) {
      expect(
        retainedEnvironmentUrl(
          withEnvironments(teardown, [
            { frameId: 'blk_1', status: 'ready', url: 'http://cf-acc-1.127.0.0.1.nip.io' },
          ]),
        ),
        `teardown=${teardown} is an unsettled reclaim, not a declaration that it outlives the run`,
      ).toBeNull()
    }
  })

  it('offers the URL only when the platform says the environment outlives its run', () => {
    const url = retainedEnvironmentUrl(
      withEnvironments('retained', [
        { frameId: 'blk_1', status: 'failed', error: 'ImagePullBackOff' },
        { frameId: 'blk_2', status: 'ready', url: 'http://cf-acc-2.127.0.0.1.nip.io' },
      ]),
    )
    expect(url).toBe('http://cf-acc-2.127.0.0.1.nip.io')
  })

  it('withholds a retained environment that never came up', () => {
    expect(
      retainedEnvironmentUrl(
        withEnvironments('retained', [{ frameId: 'blk_1', status: 'failed', error: 'boom' }]),
      ),
    ).toBeNull()
  })
})
