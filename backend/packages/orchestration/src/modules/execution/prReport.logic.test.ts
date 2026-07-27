import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { parsePrVerificationReport } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
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

/** A tester summary whose transcript fence was never closed (a killed/truncated tool dump). */
const TEST_REPORT_WITH_OPEN_FENCE = {
  greenlight: false,
  summary: 'output was:\n```\nnpm test',
  tested: [],
  outcomes: [],
  concerns: [],
}

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

  it('scrubs credentials out of every free-text field before they reach the PR', () => {
    // A PR body is a MORE exposed surface than the telemetry store (it can be a public repo),
    // so it gets the same `redactSecrets` scrub — in the prose AND in the JSON block, which is
    // why the scrub happens at compose time rather than over the rendered markdown.
    const token = 'ghp_' + 'A'.repeat(36)
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: 'tester-api',
          test: {
            attempts: 0,
            lastReport: {
              greenlight: true,
              summary: `authenticated with ${token}`,
              tested: [],
              outcomes: [],
              concerns: [],
            },
          },
        } as unknown as Partial<PipelineStep> & { agentKind: string }),
      ]),
      INPUTS,
    )
    expect(report.tests.status).toBe('reported')
    expect(JSON.stringify(report)).not.toContain(token)
    expect(renderPrVerificationReport(report)).not.toContain(token)
  })

  it('reports the LAST gate that has a verdict when a pipeline runs CI twice', () => {
    // Two `ci` gates (after the coder, and again after the tester) — the later one describes
    // the PR head as it stands now; the first is two steps of work out of date.
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: 'ci',
          gate: { phase: 'checking', attempts: 2, maxAttempts: 10, lastVerdict: 'fail' },
        } as unknown as Partial<PipelineStep> & { agentKind: string }),
        step({ agentKind: 'coder' }),
        step({
          agentKind: 'ci',
          gate: { phase: 'checking', attempts: 0, maxAttempts: 10, lastVerdict: 'pass' },
        } as unknown as Partial<PipelineStep> & { agentKind: string }),
      ]),
      INPUTS,
    )
    expect(report.ci.status).toBe('reported')
    expect(report.ci.verdict).toBe('pass')
    expect(report.ci.fixerAttempts).toBe(0)
  })

  it('names what a capped list left out instead of shortening it silently', () => {
    const failingChecks = Array.from({ length: 60 }, (_, i) => ({
      name: `check-${i}`,
      conclusion: 'failure',
    }))
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: 'ci',
          gate: {
            phase: 'checking',
            attempts: 0,
            maxAttempts: 10,
            lastVerdict: 'fail',
            failingChecks,
          },
        } as unknown as Partial<PipelineStep> & { agentKind: string }),
      ]),
      INPUTS,
    )
    expect(report.ci.failingChecks).toHaveLength(50)
    expect(report.truncations).toContain('ci.failingChecks: showing 50 of 60')
    expect(renderPrVerificationReport(report)).toContain('showing 50 of 60')
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

  it('escapes pipes so a value cannot break out of a markdown table cell', () => {
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: 'ci',
          gate: {
            phase: 'checking',
            attempts: 0,
            maxAttempts: 10,
            lastVerdict: 'fail',
            failingChecks: [{ name: 'build | lint', conclusion: 'failure' }],
          },
        } as unknown as Partial<PipelineStep> & { agentKind: string }),
      ]),
      INPUTS,
    )
    const row = renderPrVerificationReport(report)
      .split('\n')
      .find((line) => line.includes('build'))!
    expect(row).toContain('build \\| lint')
    // Four cells' worth of delimiters, not five — the value stayed inside its column.
    expect(row.split(/(?<!\\)\|/).length).toBe(4)
  })

  it('renders a title on a prose line verbatim (a pipe there is not a delimiter)', () => {
    const report = composePrVerificationReport(instance([step({ agentKind: 'coder' })]), {
      ...INPUTS,
      block: { ...BLOCK, title: 'Fix a | b parsing' } as Block,
    })
    expect(renderPrVerificationReport(report)).toContain('**Task:** Fix a | b parsing')
  })

  it('keeps a multi-line deploy error inside its table row', () => {
    // A raw newline ends the row: the rest of the error used to spill out and shred the table.
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: DEPLOYER_AGENT_KIND,
          deployEnvs: { frm_api: { status: 'failed', error: 'boom:\nline two' } },
        } as unknown as Partial<PipelineStep> & { agentKind: string }),
      ]),
      INPUTS,
    )
    const row = renderPrVerificationReport(report)
      .split('\n')
      .find((line) => line.includes('frm_api'))!
    expect(row).toContain('boom:<br>line two')
    expect(row.endsWith('|')).toBe(true)
  })

  it('never lets an unbalanced fence in agent prose swallow the JSON block', () => {
    // A truncated transcript in a tester summary would otherwise eat every section after it,
    // including the machine-readable contract.
    const report = composePrVerificationReport(
      instance([
        step({
          agentKind: 'tester-api',
          test: { attempts: 0, lastReport: TEST_REPORT_WITH_OPEN_FENCE },
        } as unknown as Partial<PipelineStep> & { agentKind: string }),
      ]),
      INPUTS,
    )
    const section = renderPrVerificationReport(report)
    const json = section.match(/```json\n([\s\S]*?)\n```/)
    expect(json, 'the JSON block must still be extractable').not.toBeNull()
    expect(parsePrVerificationReport(JSON.parse(json![1]!)).version).toBe(report.version)
  })
})
