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
    { provisioningEvents: null, evidenceUrl: null, ...inputs },
    cap,
  )
}

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

const events = (...rows: ProvisioningLifecycleEvent[]): ProvisioningLifecycleEvent[] => rows
const provisioned = (createdAt: number): ProvisioningLifecycleEvent => ({
  operation: 'provision',
  outcome: 'success',
  createdAt,
})
const tornDown = (createdAt: number): ProvisioningLifecycleEvent => ({
  operation: 'teardown',
  outcome: 'success',
  createdAt,
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
      provisioningEvents: events(provisioned(1_000), tornDown(3_000)),
      evidenceUrl: 'https://app.test/?run=exec_1&view=test-evidence',
    })

    expect(section.status).toBe('reported')
    expect(section.proof).toBe('complete')
    expect(section.gaps).toEqual([])
    expect(section.timeline).toMatchObject({
      evidenced: true,
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

  it('reports an UNREADABLE provisioning log as un-evidenced, never as "never torn down"', () => {
    // The failure this guards: an unwired log and an environment nobody reclaimed produce the
    // same empty timeline and opposite facts. Only one of them may render as a lifecycle gap
    // about the RUN.
    const section = compose([deployed, uiTester()], { provisioningEvents: null })

    expect(section.timeline.evidenced).toBe(false)
    expect(section.timeline.note).toContain('retains no provisioning event log')
    expect(section.proof).toBe('incomplete')
    expect(section.gaps.join(' ')).toContain('retains no provisioning event log')
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
      provisioningEvents: events(provisioned(1_000), tornDown(9_000)),
    })

    expect(section.teardown).toBe('confirmed')
  })

  it('separates a FAILED teardown from one nobody has performed yet', () => {
    const pending = compose([deployed, uiTester()], {
      provisioningEvents: events(provisioned(1_000)),
    })
    expect(pending.teardown).toBe('pending')
    expect(pending.gaps.join(' ')).toContain('may still be running')

    const failed = compose([deployed, uiTester()], {
      provisioningEvents: events(provisioned(1_000), {
        operation: 'teardown',
        outcome: 'failure',
        createdAt: 4_000,
      }),
    })
    expect(failed.teardown).toBe('failed')
    expect(failed.timeline.teardownFailures).toBe(1)
    expect(failed.gaps.join(' ')).toContain('needs reclaiming by hand')
  })

  it('refuses to attribute a LOCAL tester run to the ephemeral environment', () => {
    const section = compose([deployed, uiTester({ environment: 'local' })], {
      provisioningEvents: events(provisioned(1_000), tornDown(3_000)),
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
      provisioningEvents: events(provisioned(1_000), tornDown(3_000)),
    })

    expect(section.evidence.status).toBe('undeclared')
    expect(section.evidence.ranAgainst).toBeNull()
    expect(section.gaps.join(' ')).toContain('does not say where it ran')
  })

  it('flags evidence captured OUTSIDE the environment’s own lifetime', () => {
    // The tester settled at 2_000, after a teardown recorded at 1_500: the observations are real
    // and cannot be about the environment that was standing.
    const section = compose([deployed, uiTester()], {
      provisioningEvents: events(provisioned(500), tornDown(1_500)),
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
      provisioningEvents: events(provisioned(1_000), tornDown(3_000)),
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
        provisioningEvents: events(provisioned(1_000)),
      }),
    ).join('\n')

    expect(rendered).toContain('### Test environment lifecycle')
    expect(rendered).toContain('**Proof:** ⚠️ incomplete')
    expect(rendered).toContain('may still be running')
  })

  it('renders the dated timeline and the captured evidence table', () => {
    const rendered = renderEnvironments(
      compose([deployed, uiTester({}, 1_700_000_300_000)], {
        provisioningEvents: events(provisioned(1_700_000_000_000), tornDown(1_700_000_600_000)),
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
