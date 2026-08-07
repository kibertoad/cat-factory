import type { Block, ExecutionInstance, PipelineStep, SpecDoc } from '@cat-factory/kernel'
import { composeRunOutcome } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'

// A finished run produces two documents: the PR verification report a reviewer reads, and the
// outcome summary served at `GET /api/v1/runs/:runId/outcome` and rendered by the SPA. They are
// reductions of the SAME evidence for different audiences. What they may differ on is what they
// SHOW; what they may never differ on is what they COUNT, because a reader comparing the pull
// request to the app has no way to tell a different projection from a wrong one.
//
// This file is the assertion neither composer's own tests can make: each of them is internally
// consistent, and the drift these pin against lived precisely in the gap between them (which
// tester steps count, and what `not covered` is counted over). It asserts a RELATION rather than
// literals, so it keeps holding as both documents grow.

const BLOCK = {
  id: 'blk_1',
  title: 'Add login',
  level: 'task',
  status: 'pr_ready',
} as unknown as Block

function step(partial: Partial<PipelineStep> & { agentKind: string }): PipelineStep {
  return { state: 'done', progress: 1, decision: null, ...partial } as unknown as PipelineStep
}

function tester(
  kind: string,
  verdicts: { requirementId: string; status: 'met' | 'not_met' | 'not_covered' }[],
): PipelineStep {
  return step({
    agentKind: kind,
    test: {
      phase: 'testing',
      attempts: 0,
      maxAttempts: 3,
      lastReport: {
        greenlight: false,
        summary: 'Exercised the flows.',
        tested: ['login'],
        outcomes: [],
        concerns: [],
        requirementVerdicts: verdicts,
      },
    },
  } as unknown as Partial<PipelineStep> & { agentKind: string })
}

function requirement(id: string, state: 'aspirational' | 'established') {
  return {
    id,
    title: `Requirement ${id}`,
    statement: 'The system SHALL do the thing.',
    kind: 'functional' as const,
    priority: 'must' as const,
    state,
    acceptance: [],
    sourceBlockIds: [],
  }
}

const SPEC: SpecDoc = {
  service: 'accounts',
  summary: '',
  modules: [
    {
      name: 'auth',
      summary: '',
      groups: [
        {
          name: 'login',
          summary: '',
          rules: [],
          requirements: [
            requirement('req-a', 'established'),
            requirement('req-b', 'aspirational'),
            // Nobody rules on this one: it must be `not_covered` on BOTH documents rather than
            // invisible on one of them.
            requirement('req-c', 'established'),
          ],
        },
      ],
    },
  ],
}

/**
 * A run whose verdicts are split across two tester steps, carry both a regression and an
 * in-flight failure, and include one id the spec does not have. Every axis the two reductions
 * once disagreed on, in one instance.
 */
const INSTANCE: ExecutionInstance = {
  id: 'exec_1',
  blockId: 'blk_1',
  pipelineId: 'pl_ui',
  pipelineName: 'Build & verify',
  currentStep: 1,
  status: 'done',
  steps: [
    tester('tester-api', [
      { requirementId: 'req-a', status: 'not_met' },
      { requirementId: 'req-gone', status: 'met' },
    ]),
    tester('tester-ui', [{ requirementId: 'req-b', status: 'not_met' }]),
  ],
} as unknown as ExecutionInstance

const REPORT_INPUTS = {
  block: BLOCK,
  issues: [],
  runUrl: null,
  trajectoryUrl: null,
  reportUrl: null,
  environments: { provisioning: { status: 'unwired' as const }, evidenceUrl: null },
  spec: SPEC,
  now: 1_700_000_000_000,
}

describe('the run outcome summary and the PR verification report', () => {
  const report = composePrVerificationReport(INSTANCE, REPORT_INPUTS)
  const outcome = composeRunOutcome({
    block: BLOCK,
    instance: INSTANCE,
    spec: { present: true, spec: SPEC, features: [] },
  })

  it('count one run’s requirement coverage identically', () => {
    if (outcome.requirements.status !== 'reported') throw new Error('expected coverage')
    const { met, notMet, notCovered, regressions, total, unmatchedVerdicts } = outcome.requirements
    expect({ met, notMet, notCovered, regressions, total, unmatchedVerdicts }).toEqual({
      met: report.requirements.met,
      notMet: report.requirements.notMet,
      notCovered: report.requirements.notCovered,
      regressions: report.requirements.regressions,
      total: report.requirements.total,
      unmatchedVerdicts: report.requirements.unmatchedVerdicts,
    })
    // Pinned as values too, so a change that breaks BOTH sides in the same direction still fails:
    // an equality assertion alone passes happily on two composers that are wrong together.
    expect({ met, notMet, notCovered, regressions, total, unmatchedVerdicts }).toEqual({
      met: 0,
      notMet: 2,
      notCovered: 1,
      regressions: 1,
      total: 3,
      unmatchedVerdicts: 1,
    })
  })

  it('agree on which requirement is a regression, and which failure is in-flight work', () => {
    if (outcome.requirements.status !== 'reported') throw new Error('expected coverage')
    const outcomeRegressions = outcome.requirements.entries
      .filter((entry) => entry.regression)
      .map((entry) => entry.id)
    const reportRegressions = report.requirements.entries
      .filter((entry) => entry.state === 'established' && entry.verdict === 'not_met')
      .map((entry) => entry.id)
    expect(outcomeRegressions).toEqual(reportRegressions)
    expect(outcomeRegressions).toEqual(['req-a'])
  })

  it('rule on the same requirements with the same verdicts', () => {
    if (outcome.requirements.status !== 'reported') throw new Error('expected coverage')
    const verdictsOf = (rows: { id: string; verdict: string }[]) =>
      Object.fromEntries(rows.map((row) => [row.id, row.verdict]))
    expect(verdictsOf(outcome.requirements.entries)).toEqual(
      verdictsOf(report.requirements.entries),
    )
  })

  it('quote the same tester session', () => {
    if (outcome.tests.status !== 'reported') throw new Error('expected a test section')
    expect(outcome.tests.summary).toBe(report.tests.summary)
    expect(outcome.tests.areas).toEqual(report.tests.tested)
  })

  it('both REPORT a spec that declares nothing while the tester ruled on something', () => {
    // A spec with no requirements used to be an absence on both documents, which discarded
    // every verdict the tester made and then said there was nothing for it to rule on. It is a
    // spec that moved under the run, and the verdicts are the only evidence of the run there is.
    const emptySpec: SpecDoc = { service: 'accounts', summary: '', modules: [] }
    const strandedReport = composePrVerificationReport(INSTANCE, {
      ...REPORT_INPUTS,
      spec: emptySpec,
    })
    const strandedOutcome = composeRunOutcome({
      block: BLOCK,
      instance: INSTANCE,
      spec: { present: true, spec: emptySpec, features: [] },
    })
    if (strandedOutcome.requirements.status !== 'reported') throw new Error('expected coverage')
    expect(strandedReport.requirements.status).toBe('reported')
    // Three verdicts across the two tester steps, none of which the empty spec can place.
    expect(strandedOutcome.requirements.unmatchedVerdicts).toBe(3)
    expect(strandedReport.requirements.unmatchedVerdicts).toBe(3)
    expect(strandedOutcome.requirements.total).toBe(0)
    expect(strandedReport.requirements.total).toBe(0)
  })

  it('agree that a spec declaring nothing AND a silent tester is a genuine absence', () => {
    const emptySpec: SpecDoc = { service: 'accounts', summary: '', modules: [] }
    const silent = { ...INSTANCE, steps: [tester('tester-api', [])] } as ExecutionInstance
    const silentReport = composePrVerificationReport(silent, { ...REPORT_INPUTS, spec: emptySpec })
    const silentOutcome = composeRunOutcome({
      block: BLOCK,
      instance: silent,
      spec: { present: true, spec: emptySpec, features: [] },
    })
    expect(silentOutcome.requirements).toEqual({ status: 'absent', gap: 'no_requirements' })
    expect(silentReport.requirements.status).toBe('absent')
  })

  it('the report RENDERS the verdicts its join could not place, not only counts them', () => {
    // The count was computed for a reviewer and then shown to nobody, so a section reporting
    // fewer rulings than the tester made carried no explanation of the difference.
    const body = renderPrVerificationReport(report)
    expect(body).toContain('1 tester verdict')
    expect(body).toContain('`spec/` does not carry on this branch')
  })
})
