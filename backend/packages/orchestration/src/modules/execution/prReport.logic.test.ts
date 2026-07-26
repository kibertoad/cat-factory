import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { parsePrVerificationReport } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'

const BLOCK = { id: 'blk_1', title: 'Add login', level: 'task' } as unknown as Block

function step(partial: Partial<PipelineStep> & { agentKind: string }): PipelineStep {
  return {
    state: 'done',
    progress: 1,
    decision: null,
    ...partial,
  } as unknown as PipelineStep
}

function instance(
  steps: PipelineStep[],
  extra: Partial<ExecutionInstance> = {},
): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_quick',
    pipelineName: 'Quick implement',
    steps,
    currentStep: steps.length - 1,
    status: 'done',
    ...extra,
  } as ExecutionInstance
}

const INPUTS = { block: BLOCK, issues: [], runUrl: null, now: 1_700_000_000_000 }

describe('composePrVerificationReport', () => {
  it('names every section a pipeline did not produce, instead of omitting it', () => {
    const report = composePrVerificationReport(instance([step({ agentKind: 'coder' })]), INPUTS)

    expect(report.ci.status).toBe('absent')
    expect(report.ci.note).toContain('No CI gate')
    expect(report.tests.status).toBe('absent')
    expect(report.tests.note).toContain('No tester step')
    expect(report.environments.status).toBe('absent')
    expect(report.environments.note).toContain('No deployer step')
    expect(report.merge.status).toBe('absent')
    expect(report.merge.note).toContain('No merger step')
    // Still a schema-valid report — an evidence-free run publishes a truthful empty one.
    expect(() => parsePrVerificationReport(report)).not.toThrow()
  })

  it('reads the CI verdict off the gate step rather than re-probing the provider', () => {
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: 'ci',
          gate: {
            phase: 'checking',
            attempts: 2,
            maxAttempts: 10,
            headSha: 'abc123',
            lastVerdict: 'fail',
            failingChecks: [{ name: 'build', conclusion: 'failure', url: 'https://ci/1' }],
          },
        }),
      ]),
      INPUTS,
    )

    expect(report.ci.status).toBe('reported')
    expect(report.ci.verdict).toBe('fail')
    expect(report.ci.headSha).toBe('abc123')
    expect(report.ci.fixerAttempts).toBe(2)
    expect(report.ci.maxFixerAttempts).toBe(10)
    expect(report.ci.failingChecks).toEqual([
      { name: 'build', conclusion: 'failure', url: 'https://ci/1', repo: null },
    ])
  })

  it('carries the tester report and its fixer rounds', () => {
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: 'tester-api',
          test: {
            phase: 'testing',
            attempts: 1,
            maxAttempts: 3,
            lastReport: {
              greenlight: false,
              summary: 'Login works; logout regressed.',
              tested: ['login', 'logout'],
              outcomes: [
                { name: 'login', status: 'passed' },
                { name: 'logout', status: 'failed', detail: '500 on POST' },
              ],
              concerns: [{ title: 'logout 500s', detail: 'server error', severity: 'high' }],
              environment: 'local',
            },
          },
        }),
      ]),
      INPUTS,
    )

    expect(report.tests.status).toBe('reported')
    expect(report.tests.greenlight).toBe(false)
    expect(report.tests.environment).toBe('local')
    expect(report.tests.tested).toEqual(['login', 'logout'])
    expect(report.tests.outcomes).toHaveLength(2)
    expect(report.tests.concerns).toEqual([{ title: 'logout 500s', severity: 'high' }])
    expect(report.tests.fixerAttempts).toBe(1)
  })

  it('reports the deployer fan-out and whether the environments were torn down', () => {
    const deployed = step({
      agentKind: 'deployer',
      deployEnvs: {
        frm_api: { status: 'ready', url: 'https://env.test' },
        frm_web: { status: 'skipped' },
      },
    })

    // A still-live environment projection ⇒ teardown pending…
    const live = composePrVerificationReport(
      instance([
        deployed,
        step({ agentKind: 'tester-api', environment: { id: 'env_1', url: null, status: 'ready' } }),
      ]),
      INPUTS,
    )
    expect(live.environments.status).toBe('reported')
    expect(live.environments.entries).toHaveLength(2)
    expect(live.environments.teardown).toBe('pending')

    // …and a torn-down one ⇒ confirmed.
    const gone = composePrVerificationReport(
      instance([
        deployed,
        step({
          agentKind: 'tester-api',
          environment: { id: 'env_1', url: null, status: 'torn_down' },
        }),
      ]),
      INPUTS,
    )
    expect(gone.environments.teardown).toBe('confirmed')
  })

  it('reads the merger decision, and the raw assessment before the resolver has run', () => {
    const decided = composePrVerificationReport(
      instance([
        step({
          agentKind: 'merger',
          custom: {
            outcome: 'auto_merged',
            reason: 'within_thresholds',
            assessment: { complexity: 0.2, risk: 0.1, impact: 0.3, rationale: 'Small change.' },
            thresholds: { presetName: 'Balanced' },
            exceededAxes: [],
          },
        }),
      ]),
      INPUTS,
    )
    expect(decided.merge.status).toBe('reported')
    expect(decided.merge.outcome).toBe('auto_merged')
    expect(decided.merge.presetName).toBe('Balanced')
    expect(decided.merge.assessment?.complexity).toBe(0.2)

    // The window between the agent's result landing and the resolver recording its decision:
    // `step.custom` is still the RAW assessment, and the report must be truthful either way.
    const raw = composePrVerificationReport(
      instance([
        step({
          agentKind: 'merger',
          custom: { complexity: 0.4, risk: 0.5, impact: 0.6, rationale: 'Moderate.' },
        }),
      ]),
      INPUTS,
    )
    expect(raw.merge.status).toBe('reported')
    expect(raw.merge.assessment?.risk).toBe(0.5)
    expect(raw.merge.outcome).toBeNull()
  })
})

describe('renderPrVerificationReport', () => {
  it('emits a JSON block that parses back to the same report', () => {
    const report = composePrVerificationReport(
      instance([step({ agentKind: 'coder', model: 'fake' })]),
      { ...INPUTS, runUrl: 'https://app.test/?run=exec_1' },
    )
    const section = renderPrVerificationReport(report)

    expect(section).toContain('Verification report')
    expect(section).toContain('https://app.test/?run=exec_1')
    const json = section.match(/```json\n([\s\S]*?)\n```/)![1]!
    expect(parsePrVerificationReport(JSON.parse(json))).toEqual(report)
  })

  it('escapes pipes so a title cannot break out of a markdown table cell', () => {
    const report = composePrVerificationReport(instance([step({ agentKind: 'coder' })]), {
      ...INPUTS,
      block: { ...BLOCK, title: 'Fix a | b parsing' } as Block,
    })
    expect(renderPrVerificationReport(report)).toContain('Fix a \\| b parsing')
  })
})
