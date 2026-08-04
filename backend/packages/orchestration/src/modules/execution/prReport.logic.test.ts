import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { hostMarkdown } from '@cat-factory/kernel'
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
    pipelineId: 'pl_simple',
    pipelineName: 'Quick implement',
    steps,
    currentStep: steps.length - 1,
    status: 'done',
    ...extra,
  } as ExecutionInstance
}

const INPUTS = {
  block: BLOCK,
  issues: [],
  runUrl: null,
  // No provisioning log wired by default: the lifecycle section then reports itself as
  // un-evidenced, which is the honest reading of "nobody looked". The lifecycle's own cases live
  // in `prReport.environments.test.ts`.
  environments: { provisioning: { status: 'unwired' as const }, evidenceUrl: null },
  now: 1_700_000_000_000,
}

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
    expect(report.validation.status).toBe('absent')
    expect(report.validation.note).toContain('no check commands')
    expect(report.reproduction.status).toBe('absent')
    expect(report.reproduction.note).toContain('No reproduction step')
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

// ---------------------------------------------------------------------------
// Requirement → evidence. The whole point of this section is that "we didn't check" and
// "it's broken" never read the same, and that every empty case SAYS which empty it is.
// ---------------------------------------------------------------------------

const SPEC = {
  service: 'Shop',
  summary: '',
  modules: [
    {
      name: 'Identity',
      summary: '',
      groups: [
        {
          name: 'Auth',
          summary: '',
          rules: [],
          requirements: [
            {
              id: 'req-login',
              title: 'Login',
              statement: 'The system SHALL log users in.',
              kind: 'functional' as const,
              priority: 'must' as const,
              state: 'established' as const,
              sourceBlockIds: [],
              acceptance: [
                { id: 'req-login-ac-1', given: 'a user', when: 'they log in', outcome: 'a token' },
              ],
            },
            {
              id: 'req-sso',
              title: 'SSO',
              statement: 'The system SHALL support SSO.',
              kind: 'functional' as const,
              priority: 'should' as const,
              state: 'aspirational' as const,
              sourceBlockIds: [],
              acceptance: [],
            },
            {
              id: 'req-lockout',
              title: 'Lockout',
              statement: 'The system SHALL lock accounts out.',
              kind: 'functional' as const,
              priority: 'must' as const,
              state: 'established' as const,
              sourceBlockIds: [],
              acceptance: [],
            },
          ],
        },
      ],
    },
  ],
}

const testerStepOf = (agentKind: string, requirementVerdicts?: unknown) =>
  step({
    agentKind,
    test: {
      attempts: 1,
      maxAttempts: 3,
      lastReport: {
        greenlight: true,
        summary: 'ran it',
        tested: [],
        outcomes: [],
        concerns: [],
        ...(requirementVerdicts ? { requirementVerdicts } : {}),
      },
    },
  } as unknown as Partial<PipelineStep> & { agentKind: string })

const testerStep = (requirementVerdicts?: unknown) =>
  testerStepOf('tester-api', requirementVerdicts)

describe('requirement → evidence section', () => {
  it('joins the tester verdicts to the spec by requirement id', () => {
    const report = composePrVerificationReport(
      instance([
        step({ agentKind: 'coder' }),
        testerStep([
          { requirementId: 'req-login', status: 'met', detail: 'logged in and got a token' },
          { requirementId: 'req-lockout', status: 'not_met', detail: 'no lockout after 5 tries' },
        ]),
      ]),
      { ...INPUTS, spec: SPEC },
    )

    expect(report.requirements.status).toBe('reported')
    expect(report.requirements.total).toBe(3)
    expect(report.requirements.met).toBe(1)
    expect(report.requirements.notMet).toBe(1)
    // `req-sso` got no verdict at all — silence is `not_covered`, never `not_met`.
    expect(report.requirements.notCovered).toBe(1)

    const byId = Object.fromEntries(report.requirements.entries.map((e) => [e.id, e]))
    expect(byId['req-login']!.verdict).toBe('met')
    expect(byId['req-login']!.detail).toBe('logged in and got a token')
    expect(byId['req-lockout']!.verdict).toBe('not_met')
    expect(byId['req-sso']!.verdict).toBe('not_covered')
    // The state travels WITH the verdict — `not_covered` against an aspirational requirement
    // is expected, against an established one it is a coverage gap.
    expect(byId['req-sso']!.state).toBe('aspirational')
    expect(byId['req-login']!.state).toBe('established')
    expect(byId['req-login']!.module).toBe('Identity')
    expect(byId['req-login']!.group).toBe('Auth')
    expect(byId['req-login']!.criteriaCount).toBe(1)
    expect(() => parsePrVerificationReport(report)).not.toThrow()
  })

  it('distinguishes every reason the section can be empty', () => {
    // 1. No tester step at all.
    const noTester = composePrVerificationReport(instance([step({ agentKind: 'coder' })]), {
      ...INPUTS,
      spec: SPEC,
    })
    expect(noTester.requirements.status).toBe('absent')
    expect(noTester.requirements.note).toContain('No tester step')

    // 2. A tester step that has not reported yet.
    const notRun = composePrVerificationReport(
      instance([step({ agentKind: 'tester-api', state: 'working', progress: 0 })]),
      { ...INPUTS, spec: SPEC },
    )
    expect(notRun.requirements.note).toContain('no report')

    // 3. The spec could not be read — distinct from "there is no spec".
    const unreadable = composePrVerificationReport(instance([testerStep([])]), {
      ...INPUTS,
      spec: null,
    })
    expect(unreadable.requirements.note).toContain('could not be read')

    // 4. A readable spec that records NO criteria — "nobody wrote any", not "nobody checked".
    const noCriteria = composePrVerificationReport(instance([testerStep([])]), {
      ...INPUTS,
      spec: { service: 'Shop', summary: '', modules: [] },
    })
    expect(noCriteria.requirements.note).toContain('No acceptance criteria are recorded')

    for (const r of [noTester, notRun, unreadable, noCriteria]) {
      expect(r.requirements.entries).toEqual([])
      expect(r.requirements.total).toBe(0)
      expect(() => parsePrVerificationReport(r)).not.toThrow()
    }
  })

  it('renders the three verdicts distinguishably and escapes model-authored text', () => {
    const report = composePrVerificationReport(
      instance([
        testerStep([
          // A title + detail carrying every PR-body hazard: a mention, an issue reference, a
          // closing keyword, a table-breaking pipe and a newline.
          { requirementId: 'req-login', status: 'met', detail: 'ok | fine\nsecond line' },
          // Deliberately the ASPIRATIONAL requirement, so this stays a plain `not met` and the
          // test keeps asserting the three verdict markers rather than the regression one.
          { requirementId: 'req-sso', status: 'not_met', detail: 'closes #42 cc @octocat' },
        ]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    const rendered = renderPrVerificationReport(report)
    // Only the PROSE half is asserted on: the machine-readable half is inside a ```json fence,
    // where the host neither auto-links a mention nor parses a table row, so raw values there
    // are correct (and are what an external consumer must be able to read back).
    const prose = rendered.slice(0, rendered.indexOf('<details>'))
    const section = prose.slice(prose.indexOf('### Requirement verification'))

    expect(section).toContain('**1 met**')
    expect(section).toContain('✅ met')
    expect(section).toContain('❌ not met')
    expect(section).toContain('➖ not checked')
    // The hazards are neutralised: no raw mention, no live issue reference, no broken row.
    expect(prose).not.toContain('@octocat')
    expect(prose).not.toContain('#42')
    expect(prose).not.toContain('ok | fine')
    expect(prose).not.toContain('fine\nsecond line')
    // …but the machine-readable block still carries the real values.
    expect(rendered).toContain('cc @octocat')
  })

  it('keeps the FIRST verdict for a duplicated requirement id', () => {
    const report = composePrVerificationReport(
      instance([
        testerStep([
          { requirementId: 'req-login', status: 'met', detail: 'observed' },
          { requirementId: 'req-login', status: 'not_covered' },
        ]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    const login = report.requirements.entries.find((e) => e.id === 'req-login')!
    expect(login.verdict).toBe('met')
    expect(report.requirements.met).toBe(1)
  })

  it('merges the verdicts of EVERY tester step, as promotion does', () => {
    // A pipeline carrying both tester kinds promotes off both, so a report reading only the
    // last one would show `not checked` against a requirement the spec records as established.
    const report = composePrVerificationReport(
      instance([
        testerStepOf('tester-api', [{ requirementId: 'req-login', status: 'met', detail: 'api' }]),
        testerStepOf('tester-ui', [{ requirementId: 'req-sso', status: 'met', detail: 'ui' }]),
      ]),
      { ...INPUTS, spec: SPEC },
    )

    const byId = Object.fromEntries(report.requirements.entries.map((e) => [e.id, e]))
    expect(byId['req-login']!.verdict).toBe('met')
    expect(byId['req-sso']!.verdict).toBe('met')
    expect(report.requirements.met).toBe(2)
    expect(report.requirements.notCovered).toBe(1)
  })

  it('keeps the FIRST tester’s observation when two testers disagree', () => {
    // Same rule as a duplicate inside one report: a later `not_covered` must never erase an
    // earlier observation, or a UI tester that skipped an API requirement would blank it.
    const report = composePrVerificationReport(
      instance([
        testerStepOf('tester-api', [{ requirementId: 'req-login', status: 'met', detail: 'api' }]),
        testerStepOf('tester-ui', [{ requirementId: 'req-login', status: 'not_covered' }]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    expect(report.requirements.entries.find((e) => e.id === 'req-login')!.verdict).toBe('met')
  })

  it('clamps a pathological tester detail to what the table can show', () => {
    const report = composePrVerificationReport(
      instance([
        testerStep([{ requirementId: 'req-login', status: 'met', detail: 'x'.repeat(5000) }]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    const detail = report.requirements.entries.find((e) => e.id === 'req-login')!.detail!
    // Bounded in the COMPOSED object, not just the rendered cell — an unbounded value only
    // inflates the machine-readable block until the body-size backstop drops it wholesale.
    expect(detail.length).toBeLessThanOrEqual(hostMarkdown.MAX_CELL_CHARS)
    expect(detail.endsWith('…')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Regressions. `not_met` has two readings and only one of them should stop a merge: against an
// `aspirational` requirement it is work in progress, against an `established` one it is
// behaviour the service was observed to have and no longer does. The whole point of the
// implementation-state axis is that this is COMPUTABLE rather than left to a reader to
// cross-reference two columns of a table that may be capped.
// ---------------------------------------------------------------------------

/** A spec of `count` established requirements, `req-bulk-0…`, in one group. */
const bulkSpec = (count: number) => ({
  service: 'Shop',
  summary: '',
  modules: [
    {
      name: 'Identity',
      summary: '',
      groups: [
        {
          name: 'Auth',
          summary: '',
          rules: [],
          requirements: Array.from({ length: count }, (_, i) => ({
            id: `req-bulk-${i}`,
            title: `Bulk ${i}`,
            statement: 'The system SHALL do the thing.',
            kind: 'functional' as const,
            priority: 'must' as const,
            state: 'established' as const,
            sourceBlockIds: [],
            acceptance: [],
          })),
        },
      ],
    },
  ],
})

describe('requirement regressions', () => {
  it('counts a failing ESTABLISHED requirement as a regression', () => {
    const report = composePrVerificationReport(
      instance([
        testerStep([
          // `req-lockout` is established — this is a break. `req-sso` is aspirational — this is
          // simply not built yet. Both are `not_met`, and only one is a regression.
          { requirementId: 'req-lockout', status: 'not_met', detail: 'no lockout after 5 tries' },
          { requirementId: 'req-sso', status: 'not_met', detail: 'no SSO yet' },
        ]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    expect(report.requirements.notMet).toBe(2)
    expect(report.requirements.regressions).toBe(1)
  })

  it('does not count a failing ASPIRATIONAL requirement as a regression', () => {
    const report = composePrVerificationReport(
      instance([
        testerStep([{ requirementId: 'req-sso', status: 'not_met', detail: 'not built' }]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    expect(report.requirements.notMet).toBe(1)
    expect(report.requirements.regressions).toBe(0)
  })

  it('does not count an unchecked established requirement as a regression', () => {
    // Silence is not evidence of a break: a tester targets the blast radius, so most
    // established requirements are `not_covered` on any given run.
    const report = composePrVerificationReport(
      instance([testerStep([{ requirementId: 'req-login', status: 'met', detail: 'ok' }])]),
      { ...INPUTS, spec: SPEC },
    )
    expect(report.requirements.notCovered).toBe(2)
    expect(report.requirements.regressions).toBe(0)
  })

  it('leads the rendered section with the regression call-out', () => {
    const report = composePrVerificationReport(
      instance([
        testerStep([{ requirementId: 'req-lockout', status: 'not_met', detail: 'no lockout' }]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    const rendered = renderPrVerificationReport(report)
    const prose = rendered.slice(0, rendered.indexOf('<details>'))
    const section = prose.slice(prose.indexOf('### Requirement verification'))

    expect(section).toContain('**🔴 1 regression**')
    // The regression row is marked differently from a plain `not met`, or the call-out would
    // send a reviewer to a table that cannot say WHICH row it meant.
    expect(section).toContain('🔴 **regression**')
    expect(section).not.toContain('❌ not met')
    // The count is a SUBSET of `not met`, so the tallies still add up to the total.
    expect(section).toContain('**1 not met**')
  })

  it('says nothing about regressions when there are none', () => {
    const report = composePrVerificationReport(
      instance([
        testerStep([{ requirementId: 'req-sso', status: 'not_met', detail: 'not built' }]),
      ]),
      { ...INPUTS, spec: SPEC },
    )
    const section = renderPrVerificationReport(report)
    expect(section).not.toContain('regression**')
    expect(section).toContain('❌ not met')
  })

  it('keeps the regression row in the table even when the cap drops most of the spec', () => {
    // The generic cap keeps a PREFIX, and rows are emitted in spec order — so the one row a
    // reviewer must not miss would be dropped purely because of where its feature sorts.
    const total = hostMarkdown.MAX_LIST_ITEMS + 20
    const report = composePrVerificationReport(
      instance([
        testerStep([
          { requirementId: `req-bulk-${total - 1}`, status: 'not_met', detail: 'broke it' },
        ]),
      ]),
      { ...INPUTS, spec: bulkSpec(total) },
    )

    expect(report.requirements.total).toBe(total)
    expect(report.requirements.regressions).toBe(1)
    expect(report.requirements.entries).toHaveLength(hostMarkdown.MAX_LIST_ITEMS)
    expect(report.requirements.entries.map((e) => e.id)).toContain(`req-bulk-${total - 1}`)
    // Restored to spec order, so the table still reads by feature rather than by severity.
    const ids = report.requirements.entries.map((e) => e.id)
    expect(ids).toEqual([...ids].sort((a, b) => Number(a.slice(9)) - Number(b.slice(9))))
    // A capped list is only safe if it says it was capped — AND says it is not a prefix.
    expect(report.truncations.join('\n')).toContain(
      `requirements.entries: showing ${hostMarkdown.MAX_LIST_ITEMS} of ${total} ` +
        `(not the first ${hostMarkdown.MAX_LIST_ITEMS}: every regression kept)`,
    )
    expect(() => parsePrVerificationReport(report)).not.toThrow()
  })

  it('says how many regressions fit when there are more of them than the row budget', () => {
    // Priority is not a guarantee: a broken build can fail every established requirement at
    // once, and then the table physically cannot hold them all. A note claiming "every
    // regression kept" would be the same false reassurance as no note at all.
    const total = hostMarkdown.MAX_LIST_ITEMS + 20
    const failing = hostMarkdown.MAX_LIST_ITEMS + 10
    const report = composePrVerificationReport(
      instance([
        testerStep(
          Array.from({ length: failing }, (_, i) => ({
            requirementId: `req-bulk-${i}`,
            status: 'not_met',
            detail: 'broke it',
          })),
        ),
      ]),
      { ...INPUTS, spec: bulkSpec(total) },
    )

    expect(report.requirements.regressions).toBe(failing)
    expect(report.requirements.entries).toHaveLength(hostMarkdown.MAX_LIST_ITEMS)
    expect(report.truncations.join('\n')).toContain(
      `(not the first ${hostMarkdown.MAX_LIST_ITEMS}: only ${hostMarkdown.MAX_LIST_ITEMS} of ` +
        `${failing} regressions fit)`,
    )
    // The call-out counts the whole spec, so it has to admit the table holds fewer than that —
    // otherwise a reader counts the rows and concludes the difference was never broken.
    const section = renderPrVerificationReport(report)
    expect(section).toContain(`**🔴 ${failing} regressions**`)
    expect(section).toContain(`table below shows ${hostMarkdown.MAX_LIST_ITEMS} of them`)
  })

  it('leaves the truncation note plain when a capped spec has no regressions at all', () => {
    // With nothing to prioritise the selection IS the standard prefix, so an extra clause about
    // regressions would describe a reordering that did not happen.
    const total = hostMarkdown.MAX_LIST_ITEMS + 20
    const report = composePrVerificationReport(
      instance([testerStep([{ requirementId: 'req-bulk-0', status: 'met', detail: 'ok' }])]),
      { ...INPUTS, spec: bulkSpec(total) },
    )

    expect(report.requirements.regressions).toBe(0)
    expect(report.truncations).toContain(
      `requirements.entries: showing ${hostMarkdown.MAX_LIST_ITEMS} of ${total}`,
    )
    expect(report.requirements.entries.map((e) => e.id)).toEqual(
      Array.from({ length: hostMarkdown.MAX_LIST_ITEMS }, (_, i) => `req-bulk-${i}`),
    )
  })
})

describe('the section budget backstop', () => {
  /**
   * A validation report whose captured logs are far past anything the composer would retain, so
   * the rendered section blows {@link hostMarkdown.MAX_SECTION_CHARS} even after the JSON block
   * is dropped. Pathological by construction: the point is that the LAST-resort cut stays
   * well-formed, because that is the one path no realistic run exercises and therefore the one
   * nobody would notice was broken.
   */
  function oversizedValidation(): PipelineStep {
    return step({
      agentKind: 'coder',
      validation: {
        passed: false,
        attempts: 1,
        maxAttempts: 3,
        at: 1_700_000_000_000,
        outcomes: Array.from({ length: 40 }, (_, i) => ({
          label: `check-${i}`,
          command: `pnpm check-${i}`,
          exitCode: 1,
          passed: false,
          outputTail: 'F'.repeat(2_000),
        })),
      },
    } as Partial<PipelineStep> & { agentKind: string })
  }

  it('cuts to the budget without leaving a captured log’s fence hanging open', () => {
    const report = composePrVerificationReport(instance([oversizedValidation()]), INPUTS)
    const section = renderPrVerificationReport(report)

    expect(section.length).toBeLessThanOrEqual(hostMarkdown.MAX_SECTION_CHARS)
    // The whole reason this matters: an unclosed fence swallows the truncation note, every
    // section below it and the managed region's own `:end` marker into a code block. The cut
    // therefore drops the block it landed inside rather than closing it, which would ADD
    // characters to text already over the limit.
    expect(hostMarkdown.balanceFences(section)).toBe(section)
    expect(section).toContain('report truncated to fit')
  })
})
