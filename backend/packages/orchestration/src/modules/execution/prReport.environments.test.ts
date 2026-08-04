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
})
const tornDown = (createdAt: number, targetId = ENV): ProvisioningLifecycleEvent => ({
  operation: 'teardown',
  outcome: 'success',
  createdAt,
  targetId,
})
const teardownFailed = (createdAt: number, targetId = ENV): ProvisioningLifecycleEvent => ({
  operation: 'teardown',
  outcome: 'failure',
  createdAt,
  targetId,
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
      provisioning: read(provisioned(1_000), tornDown(3_000)),
      evidenceUrl: 'https://app.test/?run=exec_1&view=test-evidence',
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
    expect(section.evidence.screenshots).toEqual([
      { view: 'login', artifactId: 'art_1', hasReference: true },
      { view: 'dashboard', artifactId: 'art_2', hasReference: false },
    ])
    expect(section.evidence.url).toBe('https://app.test/?run=exec_1&view=test-evidence')
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
      provisioning: read(provisioned(1_000), tornDown(9_000)),
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
      provisioning: read(provisioned(1_000), teardownFailed(4_000), tornDown(5_000)),
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
      provisioning: read(recipeStep, provisioned(1_000), tornDown(3_000)),
    })

    expect(section.timeline.provisionedAt).toBe(1_000)
    expect(section.proof).toBe('complete')
  })

  it('refuses to attribute a LOCAL tester run to the ephemeral environment', () => {
    const section = compose([deployed, uiTester({ environment: 'local' })], {
      provisioning: read(provisioned(1_000), tornDown(3_000)),
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
      provisioning: read(provisioned(1_000), tornDown(3_000)),
    })

    expect(section.evidence.status).toBe('undeclared')
    expect(section.evidence.ranAgainst).toBeNull()
    expect(section.gaps.join(' ')).toContain('does not say where it ran')
  })

  it('flags evidence captured OUTSIDE the environment’s own lifetime', () => {
    // The tester settled at 2_000, after a teardown recorded at 1_500: the observations are real
    // and cannot be about the environment that was standing.
    const section = compose([deployed, uiTester()], {
      provisioning: read(provisioned(500), tornDown(1_500)),
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
      provisioning: read(provisioned(1_000), tornDown(3_000)),
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
        provisioning: read(provisioned(1_700_000_000_000), tornDown(1_700_000_600_000)),
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
