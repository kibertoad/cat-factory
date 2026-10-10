import type { ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  type PrReportEnvironmentInputs,
  type ProvisioningLifecycleEvent,
  composeEnvironments,
  renderEnvironments,
} from './prReport.environments.js'

// The test-environment lifecycle proof: environment UP → evidence CAPTURED from it while live →
// teardown CONFIRMED. Every case here is about the platform refusing to overstate its own
// evidence, which is the whole reason the section exists.

function step(partial: Partial<PipelineStep> & { agentKind: string }): PipelineStep {
  return { state: 'done', progress: 1, decision: null, ...partial } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_full',
    pipelineName: 'Full',
    steps,
    currentStep: steps.length - 1,
    status: 'done',
  } as ExecutionInstance
}

/** Pass-through capper: the truncation log is exercised by the report's own tests. */
const cap = <T>(items: readonly T[]): T[] => [...items]

function compose(steps: PipelineStep[], inputs: Partial<PrReportEnvironmentInputs> = {}) {
  return composeEnvironments(
    instance(steps),
    { provisioning: { status: 'unwired' }, evidenceUrl: null, ...inputs },
    cap,
  )
}

/** The happy-path read: the log was queried whole and holds exactly these rows. */
const read = (...events: ProvisioningLifecycleEvent[]): PrReportEnvironmentInputs['provisioning'] =>
  ({ status: 'read', events }) as const

const deployed = step({
  agentKind: 'deployer',
  deployEnvs: {
    frm_api: { status: 'ready', url: 'https://env.test' },
    frm_web: { status: 'skipped' },
  },
})

/** A settled UI tester that ran against the ephemeral environment and captured a screenshot. */
function uiTester(overrides: Record<string, unknown> = {}, finishedAt = 2_000): PipelineStep {
  return step({
    agentKind: 'tester-ui',
    finishedAt,
    test: {
      attempts: 0,
      lastReport: {
        greenlight: true,
        summary: 'Exercised login end to end.',
        tested: ['login'],
        outcomes: [{ name: 'login', status: 'passed' }],
        concerns: [],
        environment: 'ephemeral',
        requirementVerdicts: [{ requirementId: 'req-login', status: 'met' }],
        screenshots: [
          { view: 'login', artifactId: 'art_1', referenceArtifactId: 'art_ref' },
          { view: 'dashboard', artifactId: 'art_2' },
        ],
        ...overrides,
      },
    },
  } as unknown as Partial<PipelineStep> & { agentKind: string })
}

// The log rows a run's environment lifecycle is folded from. `targetId` is the ENVIRONMENT the
// attempt acted on, and defaulting it to one id keeps the single-environment cases readable while
// the multi-environment cases below name theirs.
const ENV = 'env_1'
const provisioned = (createdAt: number, targetId = ENV): ProvisioningLifecycleEvent => ({
  operation: 'provision',
  outcome: 'success',
  createdAt,
  targetId,
  error: null,
})
const tornDown = (createdAt: number, targetId = ENV): ProvisioningLifecycleEvent => ({
  operation: 'teardown',
  outcome: 'success',
  createdAt,
  targetId,
  error: null,
})
const teardownFailed = (createdAt: number, targetId = ENV): ProvisioningLifecycleEvent => ({
  operation: 'teardown',
  outcome: 'failure',
  createdAt,
  targetId,
  error: null,
})
/**
 * The INDEPENDENT probe that found the environment gone — what turns a teardown the platform
 * ASKED for into one it can prove happened. A `tornDown` row without one of these is deliberately
 * not a reclaim (see the `unconfirmed` cases below).
 */
const verifiedGone = (createdAt: number, targetId = ENV): ProvisioningLifecycleEvent => ({
  operation: 'teardown-verify',
  outcome: 'success',
  createdAt,
  targetId,
  error: null,
})
/** The probe ran and could not establish the environment is gone, with the provider's reason. */
const verifyFailed = (
  createdAt: number,
  error: string,
  targetId = ENV,
): ProvisioningLifecycleEvent => ({
  operation: 'teardown-verify',
  outcome: 'failure',
  createdAt,
  targetId,
  error,
})

describe('composeEnvironments', () => {
  it('names the absent section when the pipeline has no deployer step', () => {
    const section = compose([step({ agentKind: 'coder' })])

    expect(section.status).toBe('absent')
    expect(section.note).toContain('No deployer step')
    expect(section.proof).toBe('not_applicable')
    expect(section.gaps).toEqual([])
  })

  it('reports a complete proof when the environment came up, was used, and was reclaimed', () => {
    const section = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000), tornDown(3_000), verifiedGone(3_001)),
      evidenceUrl: 'https://app.test/?run=exec_1&view=test-evidence',
      artifactUrl: (id) => `https://api.test/workspaces/ws_1/artifacts/${id}/blob`,
    })

    expect(section.status).toBe('reported')
    expect(section.proof).toBe('complete')
    expect(section.gaps).toEqual([])
    expect(section.timeline).toMatchObject({
      gap: null,
      provisionedAt: 1_000,
      tornDownAt: 3_000,
    })
    expect(section.teardown).toBe('confirmed')
    expect(section.evidence.status).toBe('captured')
    // Each captured artifact carries a DIRECT link to its bytes beside its id: the id is what an
    // operator greps the store for, the link is what a reviewer (or a tool holding a key) opens.
    expect(section.evidence.screenshots).toEqual([
      {
        view: 'login',
        artifactId: 'art_1',
        hasReference: true,
        url: 'https://api.test/workspaces/ws_1/artifacts/art_1/blob',
      },
      {
        view: 'dashboard',
        artifactId: 'art_2',
        hasReference: false,
        url: 'https://api.test/workspaces/ws_1/artifacts/art_2/blob',
      },
    ])
    expect(section.evidence.url).toBe('https://app.test/?run=exec_1&view=test-evidence')
  })

  it('lists an artifact by id alone when no backend URL is configured', () => {
    // A deployment with no public backend URL must get the id and NO link — the report never
    // emits a link to nowhere, and dropping the id in favour of one would leave a reviewer with
    // nothing at all.
    const section = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000), tornDown(3_000), verifiedGone(3_001)),
      evidenceUrl: null,
    })

    expect(section.evidence.screenshots.map((s) => s.url)).toEqual([null, null])
    expect(section.evidence.screenshots.map((s) => s.artifactId)).toEqual(['art_1', 'art_2'])
  })

  it('reports an UNWIRED provisioning log as un-evidenced, never as "never torn down"', () => {
    // The failure this guards: an unwired log and an environment nobody reclaimed produce the
    // same empty timeline and opposite facts. Only one of them may render as a lifecycle gap
    // about the RUN.
    const section = compose([deployed, uiTester()], { provisioning: { status: 'unwired' } })

    expect(section.timeline.gap).toBe('unwired')
    expect(section.timeline.note).toContain('retains no provisioning event log')
    expect(section.proof).toBe('incomplete')
    expect(section.gaps.join(' ')).toContain('retains no provisioning event log')
  })

  it('keeps a FAILED read apart from a deployment that retains no log', () => {
    // Both come back with nothing to fold, and only one of them is a statement about how the
    // deployment is configured. Telling a reviewer "this deployment retains no provisioning
    // event log" because a query timed out is a fabricated fact about their setup.
    const section = compose([deployed, uiTester()], { provisioning: { status: 'unreadable' } })

    expect(section.timeline.gap).toBe('unreadable')
    expect(section.timeline.note).toContain('could not be read')
    expect(section.timeline.note).not.toContain('retains no provisioning event log')
    expect(section.gaps.join(' ')).toContain('transient read failure')
  })

  it('refuses to date a lifecycle from a TRUNCATED history', () => {
    // A partial history is the one input that yields a CONFIDENT wrong answer: rows arrive
    // newest first, so an environment whose bring-up fell off the end reads as one that never
    // existed, and therefore as one that never needed reclaiming.
    const section = compose([deployed, uiTester()], { provisioning: { status: 'truncated' } })

    expect(section.timeline.gap).toBe('truncated')
    expect(section.timeline.provisionedAt).toBeNull()
    expect(section.proof).toBe('incomplete')
    expect(section.gaps.join(' ')).toContain('history is incomplete')
  })

  it('says a run with no deployer step stood nothing up, rather than blaming the log', () => {
    // The section is `absent` either way, but its JSON is read by machines: reporting "this
    // deployment retains no provisioning event log" about a wired one because the run had no
    // deployer to query for is a false claim about the deployment.
    const section = compose([step({ agentKind: 'coder' })], {
      provisioning: { status: 'not_provisioned' },
    })

    expect(section.status).toBe('absent')
    expect(section.timeline.gap).toBe('not_provisioned')
    expect(section.timeline.note).toContain('no deployer step')
  })

  it('trusts a RECORDED teardown over a step projection the run stopped refreshing', () => {
    // The per-step projection is written by the run's own polls and is never refreshed after the
    // run settles, so a TTL-swept environment keeps a stale `ready` projection forever. Before
    // the log was consulted, that made "teardown confirmed" structurally unreachable.
    const staleProjection = step({
      agentKind: 'tester-api',
      environment: { id: 'env_1', url: null, status: 'ready' },
    })
    const section = compose([deployed, staleProjection, uiTester()], {
      provisioning: read(provisioned(1_000), tornDown(9_000), verifiedGone(9_001)),
    })

    expect(section.teardown).toBe('confirmed')
  })

  it('separates a FAILED teardown from one nobody has performed yet', () => {
    const pending = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000)),
    })
    expect(pending.teardown).toBe('pending')
    expect(pending.gaps.join(' ')).toContain('may still be running')

    const failed = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000), teardownFailed(4_000)),
    })
    expect(failed.teardown).toBe('failed')
    expect(failed.timeline.teardownFailures).toBe(1)
    expect(failed.gaps.join(' ')).toContain('needs reclaiming by hand')
  })

  it('separates an environment kept ON PURPOSE from one nobody reclaimed', () => {
    // Same evidence on both runs: something came up and nothing took it down. What differs is
    // whether the run ever undertook to. `pending` tells a reviewer to wait for a teardown and an
    // operator to go find the failure; on a preview environment there is neither, and the section
    // said so in exactly the words that send both of them looking.
    const retaining = step({
      agentKind: 'deployer',
      stepOptions: { retainEnvironment: true },
      deployEnvs: { frm_api: { status: 'ready', url: 'https://env.test' } },
    })
    const section = compose([retaining, uiTester()], { provisioning: read(provisioned(1_000)) })

    expect(section.teardown).toBe('retained')
    // Nothing is MISSING from the proof: the run did everything it undertook to do.
    expect(section.proof).toBe('complete')
    expect(section.gaps).toEqual([])
    // And the environment being still live is stated rather than left to be inferred.
    expect(renderEnvironments(section).join('\n')).toContain('retained past the run by design')
  })

  it('never lets a retain declaration soften a teardown that was attempted', () => {
    // The declaration says "no reclaim is coming from this run". It says nothing about one that
    // ran and failed, or one that ran and could not be verified, and must not launder either.
    const retaining = step({
      agentKind: 'deployer',
      stepOptions: { retainEnvironment: true },
      deployEnvs: { frm_api: { status: 'ready', url: 'https://env.test' } },
    })
    expect(
      compose([retaining, uiTester()], {
        provisioning: read(provisioned(1_000), teardownFailed(4_000)),
      }).teardown,
    ).toBe('failed')
    expect(
      compose([retaining, uiTester()], {
        provisioning: read(provisioned(1_000), tornDown(9_000)),
      }).teardown,
    ).toBe('unconfirmed')
  })

  it('refuses to call an UNVERIFIED teardown a reclaim', () => {
    // The regression this exists for: a provider whose teardown is a declared no-op (a manifest
    // with no `teardown:` request) returns success having destroyed nothing. Reading the teardown
    // row alone put a green tick on a PR about an environment that was still running and still
    // billing. A teardown with no successful verify beside it is `unconfirmed`, never `confirmed`.
    const section = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000), tornDown(3_000)),
    })

    expect(section.teardown).toBe('unconfirmed')
    expect(section.proof).toBe('incomplete')
    expect(section.timeline.teardownsUnconfirmed).toBe(1)
    expect(section.gaps.join(' ')).toContain('could not be confirmed gone')
  })

  it('surfaces the probe’s own reason for an unconfirmed teardown', () => {
    // "The manifest declares no teardown request" and "the apiserver refused the read" are the
    // same verdict and completely different jobs, so the verbatim cause travels to the PR rather
    // than a generic line a reader has to go to the logs to act on.
    const section = compose([deployed, uiTester()], {
      provisioning: read(
        provisioned(1_000),
        tornDown(3_000),
        verifyFailed(3_100, 'The environment was still running after the teardown.'),
      ),
    })

    expect(section.teardown).toBe('unconfirmed')
    expect(section.gaps.join(' ')).toContain('still running after the teardown')
  })

  it('keeps an unconfirmed teardown apart from one nobody has attempted', () => {
    // Both leave an environment possibly standing, and they need different people: nobody has
    // asked yet vs the platform asked and could not check. Flattening them would tell an operator
    // to wait for a teardown that already happened, or to chase one that has not.
    const unattempted = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000)),
    })
    const unverified = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000), tornDown(3_000)),
    })

    expect(unattempted.teardown).toBe('pending')
    expect(unverified.teardown).toBe('unconfirmed')
  })

  it('reports the run as pending when ANY environment has no teardown at all', () => {
    // A run holding one unverified teardown and one environment nobody touched is `pending`, the
    // more alarming of the two: an untouched environment is certainly still up, where an
    // unverified one merely might be.
    const twoFrames = step({
      agentKind: 'deployer',
      deployEnvs: {
        frm_api: { status: 'ready', url: 'https://api.test' },
        frm_web: { status: 'ready', url: 'https://web.test' },
      },
    })
    const section = compose([twoFrames, uiTester()], {
      provisioning: read(
        provisioned(1_000, 'env_a'),
        provisioned(1_100, 'env_b'),
        tornDown(3_000, 'env_a'),
      ),
    })

    expect(section.teardown).toBe('pending')
  })

  it('counts a stuck environment once however many times the sweep retried it', () => {
    // The sweep retries every pass, so a provider that keeps refusing appends a failure row per
    // pass. Counting rows would report one wedged environment as a growing fleet of them.
    const section = compose([deployed, uiTester()], {
      provisioning: read(provisioned(1_000), teardownFailed(4_000), teardownFailed(5_000)),
    })

    expect(section.teardown).toBe('failed')
    expect(section.timeline.teardownFailures).toBe(1)
  })

  it('reads a retry that finally SUCCEEDED as reclaimed, not as still stuck', () => {
    // Latest-attempt-wins: an environment that failed once and went away on the next pass is
    // gone, and reporting it as needing a human is a false alarm on a settled PR.
    const section = compose([deployed, uiTester()], {
      provisioning: read(
        provisioned(1_000),
        teardownFailed(4_000),
        tornDown(5_000),
        verifiedGone(5_001),
      ),
    })

    expect(section.teardown).toBe('confirmed')
    expect(section.timeline.teardownFailures).toBe(0)
    expect(section.proof).toBe('complete')
  })

  it('does not let a SUPERSEDED environment balance the books for its replacement', () => {
    // A run that re-provisions a frame tears the prior environment down under the SAME run, so a
    // tally of teardowns against ready frames reaches 1-of-1 while the replacement is still
    // standing. Following ids individually is the only form that survives this.
    const section = compose([deployed, uiTester()], {
      provisioning: read(
        provisioned(1_000, 'env_old'),
        tornDown(2_500, 'env_old'),
        verifiedGone(2_501, 'env_old'),
        provisioned(2_600, 'env_new'),
      ),
    })

    expect(section.teardown).toBe('pending')
    expect(section.gaps.join(' ')).toContain('may still be running')
    // The superseded environment going away mid-run is not the end of the lifecycle, so the
    // tester settling after it must not be reported as testing against a dead environment.
    expect(section.gaps.join(' ')).not.toContain('AFTER the environment was torn down')
  })

  it('ignores stack-recipe step rows, which name no environment, when dating the bring-up', () => {
    // A multi-step recipe logs a `provision` row per STEP with no `targetId`. Reading the first
    // as the bring-up dates the environment to before it existed, which then reads as a tester
    // that settled before its environment came up.
    const recipeStep = { ...provisioned(400), targetId: null }
    const section = compose([deployed, uiTester()], {
      provisioning: read(recipeStep, provisioned(1_000), tornDown(3_000), verifiedGone(3_001)),
    })

    expect(section.timeline.provisionedAt).toBe(1_000)
    expect(section.proof).toBe('complete')
  })

  it('refuses to attribute a LOCAL tester run to the ephemeral environment', () => {
    const section = compose([deployed, uiTester({ environment: 'local' })], {
      provisioning: read(provisioned(1_000), tornDown(3_000), verifiedGone(3_001)),
    })

    expect(section.evidence.status).toBe('local')
    expect(section.evidence.ranAgainst).toBe('local')
    // The artifacts are still reported (they exist and a reviewer should reach them), but the
    // proof does not count them as evidence about this environment.
    expect(section.evidence.screenshots).toHaveLength(2)
    expect(section.proof).toBe('incomplete')
    expect(section.gaps.join(' ')).toContain('not evidence about the ephemeral environment')
  })

  it('keeps an UNDECLARED tester environment apart from a declared local one', () => {
    const section = compose([deployed, uiTester({ environment: undefined })], {
      provisioning: read(provisioned(1_000), tornDown(3_000), verifiedGone(3_001)),
    })

    expect(section.evidence.status).toBe('undeclared')
    expect(section.evidence.ranAgainst).toBeNull()
    expect(section.gaps.join(' ')).toContain('does not say where it ran')
  })

  it('flags evidence captured OUTSIDE the environment’s own lifetime', () => {
    // The tester settled at 2_000, after a teardown recorded at 1_500: the observations are real
    // and cannot be about the environment that was standing.
    const section = compose([deployed, uiTester()], {
      provisioning: read(provisioned(500), tornDown(1_500), verifiedGone(1_501)),
    })

    expect(section.proof).toBe('incomplete')
    expect(section.gaps.join(' ')).toContain('AFTER the environment was torn down')
  })

  it('reports a frame that failed to provision as part of the system never standing up', () => {
    const partlyFailed = step({
      agentKind: 'deployer',
      deployEnvs: {
        frm_api: { status: 'ready', url: 'https://env.test' },
        frm_web: { status: 'failed', error: 'quota exceeded' },
      },
    })
    const section = compose([partlyFailed, uiTester()], {
      provisioning: read(provisioned(1_000), tornDown(3_000), verifiedGone(3_001)),
    })

    expect(section.proof).toBe('incomplete')
    expect(section.gaps.join(' ')).toContain('failed to provision')
  })

  it('treats an all-infraless fan-out as nothing to prove', () => {
    const skipped = step({ agentKind: 'deployer', deployEnvs: { frm_web: { status: 'skipped' } } })

    expect(compose([skipped, uiTester()]).proof).toBe('not_applicable')
  })
})

describe('renderEnvironments', () => {
  it('leads with the computed proof and lists every gap behind it', () => {
    const rendered = renderEnvironments(
      compose([deployed, uiTester({ environment: 'local' })], {
        provisioning: read(provisioned(1_000)),
      }),
    ).join('\n')

    expect(rendered).toContain('### Test environment lifecycle')
    expect(rendered).toContain('**Proof:** ⚠️ incomplete')
    expect(rendered).toContain('may still be running')
  })

  it('renders the dated timeline and the captured evidence table', () => {
    const rendered = renderEnvironments(
      compose([deployed, uiTester({}, 1_700_000_300_000)], {
        provisioning: read(
          provisioned(1_700_000_000_000),
          tornDown(1_700_000_600_000),
          verifiedGone(1_700_000_600_001),
        ),
        evidenceUrl: 'https://app.test/?run=exec_1&view=test-evidence',
      }),
    ).join('\n')

    expect(rendered).toContain('environment up → evidence captured against it → teardown confirmed')
    expect(rendered).toContain('**Timeline:** up 2023-11-14')
    expect(rendered).toContain('torn down 2023-11-14')
    expect(rendered).toContain('[Open the captured evidence](https://app.test/')
    expect(rendered).toContain('| login | `art_1` | paired |')
  })

  it('defuses a hostile frame id / view name rather than letting the host act on it', () => {
    const hostile = step({
      agentKind: 'deployer',
      deployEnvs: { 'closes #1 @everyone': { status: 'ready', url: 'https://env.test' } },
    })
    const rendered = renderEnvironments(compose([hostile, uiTester()])).join('\n')

    expect(rendered).not.toContain('#1')
    expect(rendered).not.toContain('@everyone')
  })
})

// The REMEDIATION half: what the platform tried about a frame whose provision failed. Both loops
// record on the deployer step and nothing reduced either into the report, so a run that failed,
// was diagnosed, was restarted and then came up said exactly what a run with no loop wired says.
describe('composeEnvironments: remediation', () => {
  const failedFrame = {
    frm_api: { status: 'failed' as const, error: 'namespace never became ready' },
  }

  /** One settled investigation round, defaulting to the shape the motivating incident had. */
  function investigationRound(overrides: Record<string, unknown> = {}) {
    return {
      attempt: 1,
      at: 5_000,
      outcome: 'remediated',
      error: 'namespace never became ready',
      verdict: {
        faultLayer: 'provider',
        summary: 'The VM behind the environment went offline under a deploy job that succeeded.',
        evidence: [{ source: 'provider.describe', statement: 'jobs[0].vm.status=offline' }],
        action: 'restart',
        actionRationale: 'The workload is the only thing that has to move.',
      },
      ranAction: 'restart',
      ...overrides,
    }
  }

  /** A settled `deploy-fixer` round. */
  function fixRound(attempt: number, outcome: 'completed' | 'failed') {
    return {
      attempt,
      at: attempt * 1_000,
      outcome,
      reason: 'manifest_invalid',
      error: 'image "" is not a valid reference',
      summary: outcome === 'completed' ? 'set the image tag' : null,
    }
  }

  /** A deployer step whose own frame failed, carrying whatever loop state the case is about. */
  function deployerWith(state: Record<string, unknown>): PipelineStep {
    return step({
      agentKind: 'deployer',
      deployEnvs: failedFrame,
      ...state,
    } as unknown as Partial<PipelineStep> & { agentKind: string })
  }

  it('leaves the entry untouched when neither loop ran', () => {
    const section = compose([deployed])

    expect(section.entries.map((entry) => entry.remediation)).toEqual([undefined, undefined])
  })

  it('carries the fixer rounds, telling a job that finished from one that died', () => {
    const section = compose([
      deployerWith({
        deployFix: {
          phase: 'retrying',
          attempts: 2,
          maxAttempts: 2,
          frameId: 'frm_api',
          reason: 'manifest_invalid',
          lastError: 'image "" is not a valid reference',
          attemptLog: [fixRound(1, 'completed'), fixRound(2, 'failed')],
        },
      }),
    ])

    expect(section.entries[0]!.remediation?.deployFix).toEqual({
      attempts: 2,
      maxAttempts: 2,
      cycles: 1,
      reason: 'manifest_invalid',
      completed: 1,
      failed: 1,
      droppedRounds: 0,
    })
  })

  it('carries the verdict, what ran, and the extensions a `wait` won', () => {
    const section = compose([
      deployerWith({
        environmentInvestigation: {
          attempts: 2,
          maxAttempts: 2,
          frameId: 'frm_api',
          waitExtensions: 1,
          attemptLog: [
            investigationRound({
              verdict: { ...investigationRound().verdict, action: 'wait' },
              ranAction: 'wait',
            }),
            investigationRound({ attempt: 2 }),
          ],
        },
      }),
    ])

    expect(section.entries[0]!.remediation?.investigation).toEqual({
      attempts: 2,
      maxAttempts: 2,
      cycles: 1,
      droppedRounds: 0,
      faultLayer: 'provider',
      action: 'restart',
      ranActions: ['wait', 'restart'],
      withheld: null,
      failure: null,
      waitExtensions: 1,
    })
  })

  it('keeps an earlier round that ACTED rather than reporting only the last verdict', () => {
    const section = compose([
      deployerWith({
        environmentInvestigation: {
          attempts: 2,
          maxAttempts: 2,
          frameId: 'frm_api',
          attemptLog: [
            investigationRound(),
            investigationRound({
              attempt: 2,
              outcome: 'reported',
              verdict: { ...investigationRound().verdict, action: 'stop' },
              ranAction: null,
            }),
          ],
        },
      }),
    ])
    const investigation = section.entries[0]!.remediation?.investigation

    // The last round asked for nothing, and a last-wins read would report a diagnosis nobody
    // acted on, of an environment the platform had already restarted.
    expect(investigation?.ranActions).toEqual(['restart'])
    expect(investigation?.action).toBe('stop')
  })

  it('states a round that produced no verdict rather than reporting the `unknown` layer', () => {
    const section = compose([
      deployerWith({
        environmentInvestigation: {
          attempts: 1,
          maxAttempts: 2,
          frameId: 'frm_api',
          attemptLog: [
            {
              attempt: 1,
              at: 5_000,
              outcome: 'failed',
              error: 'namespace never became ready',
              failure: 'the provider credentials could not be opened',
            },
          ],
        },
      }),
    ])
    const investigation = section.entries[0]!.remediation?.investigation

    // `unknown` is a verdict the investigator REACHED; this is the absence of one, and the two
    // send different people to different places.
    expect(investigation?.faultLayer).toBeNull()
    expect(investigation?.failure).toBe('the provider credentials could not be opened')
    expect(investigation?.ranActions).toEqual([])
  })

  it('names a refused remedy so it never reads as one that ran and did not help', () => {
    const section = compose([
      deployerWith({
        environmentInvestigation: {
          attempts: 1,
          maxAttempts: 1,
          frameId: 'frm_api',
          attemptLog: [
            investigationRound({
              outcome: 'reported',
              ranAction: null,
              withheld: 'This deployment does not allow the platform to act on an environment.',
            }),
          ],
        },
      }),
    ])
    const investigation = section.entries[0]!.remediation?.investigation

    expect(investigation?.action).toBe('restart')
    expect(investigation?.ranActions).toEqual([])
    expect(investigation?.withheld).toContain('does not allow')
  })

  it('accumulates across deployer steps rather than letting the last deploy win', () => {
    // A frame the fixer repaired, then re-deployed cleanly by a later deployer step. The entry's
    // status is the CLEAN one; the record of the machine edit has to survive it.
    const repaired = deployerWith({
      deployFix: {
        phase: 'retrying',
        attempts: 1,
        maxAttempts: 2,
        frameId: 'frm_api',
        reason: 'manifest_invalid',
        lastError: 'e',
        attemptLog: [fixRound(1, 'completed')],
      },
    })
    const redeployed = step({
      agentKind: 'deployer',
      deployEnvs: { frm_api: { status: 'ready', url: 'https://env.test' } },
    })
    const section = compose([repaired, redeployed])

    expect(section.entries[0]!.status).toBe('ready')
    expect(section.entries[0]!.remediation?.deployFix).toMatchObject({ attempts: 1, completed: 1 })
  })

  it('renders the attempted remediation under the outcomes table', () => {
    const rendered = renderEnvironments(
      compose([
        deployerWith({
          deployFix: {
            phase: 'retrying',
            attempts: 1,
            maxAttempts: 2,
            frameId: 'frm_api',
            reason: 'manifest_invalid',
            lastError: 'e',
            attemptLog: [fixRound(1, 'failed')],
          },
          environmentInvestigation: {
            attempts: 1,
            maxAttempts: 2,
            frameId: 'frm_api',
            waitExtensions: 1,
            attemptLog: [investigationRound()],
          },
        }),
      ]),
    ).join('\n')

    expect(rendered).toContain('**Remediation attempted**')
    expect(rendered).toContain(
      '1 of 2 repair round(s) for `manifest_invalid` (1 died without finishing)',
    )
    expect(rendered).toContain('fault: `provider`')
    expect(rendered).toContain('ran: `restart`')
    expect(rendered).toContain('readiness ceiling extended 1')
  })

  it('counts the rounds off the run-long log, never the counter a loop-back re-armed', () => {
    // Two rounds ran, a human-test gate rebuilt the environment, and the new cycle has spent
    // nothing yet. Reading the live counter reported "0 of 2 repair round(s) (2 finished)", an
    // in-flight count of minus two, on exactly the loop-back this section exists to report.
    const section = compose([
      deployerWith({
        deployFix: {
          phase: 'retrying',
          attempts: 0,
          cycle: 1,
          maxAttempts: 2,
          frameId: 'frm_api',
          reason: 'manifest_invalid',
          lastError: 'image "" is not a valid reference',
          attemptLog: [fixRound(1, 'completed'), fixRound(2, 'completed')],
        },
      }),
    ])

    expect(section.entries[0]!.remediation?.deployFix).toMatchObject({
      attempts: 2,
      completed: 2,
      failed: 0,
      cycles: 2,
    })
  })

  it('never renders more rounds than the budget it prints them against', () => {
    // Two deployer steps, each spending its own two-round budget on the same frame. `attempts`
    // accumulates and `maxAttempts` is per CYCLE, so the ratio form would read "4 of 2" and tell
    // a reviewer the bound is not enforced.
    const spender = (attempt: number) =>
      deployerWith({
        deployFix: {
          phase: 'retrying',
          attempts: 2,
          maxAttempts: 2,
          frameId: 'frm_api',
          reason: 'manifest_invalid',
          lastError: 'e',
          attemptLog: [fixRound(attempt, 'completed'), fixRound(attempt + 1, 'completed')],
        },
      })
    const rendered = renderEnvironments(compose([spender(1), spender(3)])).join('\n')

    expect(rendered).toContain('4 repair round(s) over 2 provisioning cycles (2 per cycle)')
    expect(rendered).not.toContain('4 of 2')
  })

  it('reads every decision off the ONE round that made it, across deployer steps', () => {
    // A refusal belongs to the decision it refused. Falling back to an earlier step's `withheld`
    // reported a remedy as blocked that the later step in fact RAN, and an earlier step's
    // `failure` beside a fresh verdict reported an investigation that had since succeeded.
    const refused = deployerWith({
      environmentInvestigation: {
        attempts: 2,
        maxAttempts: 2,
        frameId: 'frm_api',
        attemptLog: [
          investigationRound({
            outcome: 'reported',
            ranAction: null,
            withheld: 'This deployment does not allow the platform to act on an environment.',
          }),
          {
            attempt: 2,
            at: 6_000,
            outcome: 'failed',
            error: 'namespace never became ready',
            failure: 'the provider credentials could not be opened',
          },
        ],
      },
    })
    const acted = deployerWith({
      environmentInvestigation: {
        attempts: 1,
        maxAttempts: 2,
        frameId: 'frm_api',
        attemptLog: [investigationRound({ attempt: 3, at: 9_000 })],
      },
    })
    const investigation = compose([refused, acted]).entries[0]!.remediation?.investigation

    expect(investigation?.ranActions).toEqual(['restart'])
    expect(investigation?.withheld).toBeNull()
    expect(investigation?.failure).toBeNull()
  })

  it('lists a frame whose outcome a loop CLEARED, rather than reporting nothing was attempted', () => {
    // Both loops clear the frame's recorded outcome to make the re-provision happen. A report
    // composed in that window (the run was abandoned, timed out, or failed at another step) read
    // as a deployer that recorded nothing at all, on a run where the platform demonstrably acted.
    const section = compose([
      step({
        agentKind: 'deployer',
        deployEnvs: {},
        environmentInvestigation: {
          attempts: 1,
          maxAttempts: 2,
          frameId: 'frm_api',
          attemptLog: [investigationRound()],
        },
      } as unknown as Partial<PipelineStep> & { agentKind: string }),
    ])

    expect(section.status).toBe('reported')
    expect(section.entries[0]).toMatchObject({ frameId: 'frm_api', status: 'unsettled' })
    expect(section.entries[0]!.remediation?.investigation?.ranActions).toEqual(['restart'])
    expect(section.gaps.some((gap) => gap.includes('no settled provisioning outcome'))).toBe(true)
  })

  it('folds a multi-line refusal into its bullet rather than spilling it into the body', () => {
    // `withheld` and `failure` carry a provider's own words, which are routinely multi-line. A
    // raw newline ends the list item and lands the tail in a public pull-request body as prose.
    const rendered = renderEnvironments(
      compose([
        deployerWith({
          environmentInvestigation: {
            attempts: 1,
            maxAttempts: 1,
            frameId: 'frm_api',
            attemptLog: [
              investigationRound({
                outcome: 'reported',
                ranAction: null,
                withheld: 'the provider refused:\nError from server (Forbidden)\nnamespaces',
              }),
            ],
          },
        }),
      ]),
    ).join('\n')
    const bullet = rendered.split('\n').find((line) => line.includes('withheld:'))

    expect(bullet).toContain('Error from server (Forbidden)')
    expect(bullet).toContain('namespaces')
    expect(rendered).not.toMatch(/^namespaces/m)
  })

  it('says nothing about remediation when nothing was attempted', () => {
    const rendered = renderEnvironments(compose([deployed, uiTester()])).join('\n')

    expect(rendered).not.toContain('Remediation attempted')
  })
})
