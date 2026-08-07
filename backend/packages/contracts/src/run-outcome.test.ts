import { describe, expect, it } from 'vitest'
import type { Block } from './entities.js'
import type { ExecutionInstance, PipelineStep } from './execution.js'
import type { ServiceSpecView } from './spec.js'
import { composeRunOutcome, hasOutcomeToShow } from './run-outcome.js'

// The composer's whole job is to keep facts that mean different things from rendering the same,
// so the cases worth pinning are the COLLAPSES: an absent producer vs a producer that found
// nothing, an aspirational failure vs a regression, a capture nobody reviewed vs a pair a human
// approved, and a tester that could not run vs one that ran and raised concerns.

function block(overrides: Partial<Block> = {}): Block {
  return {
    id: 'blk_1',
    title: 'Password reset',
    description: '  Let a signed-out user reset their password by email.  ',
    status: 'pr_ready',
    level: 'task',
    type: 'task',
    parentId: 'frm_1',
    position: { x: 0, y: 0 },
    progress: 0,
    dependsOn: [],
    taskType: 'feature',
    ...overrides,
  } as Block
}

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'coder',
    state: 'done',
    progress: 1,
    decision: null,
    ...overrides,
  } as PipelineStep
}

function run(steps: PipelineStep[], overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exe_1',
    blockId: 'blk_1',
    pipelineId: 'pl_1',
    pipelineName: 'Build',
    steps,
    currentStep: 0,
    status: 'running',
    ...overrides,
  } as ExecutionInstance
}

function testerStep(report: Record<string, unknown>, kind = 'tester-ui'): PipelineStep {
  return step({
    agentKind: kind,
    test: {
      phase: 'testing',
      attempts: 0,
      maxAttempts: 3,
      lastReport: {
        greenlight: true,
        summary: 'Exercised the reset flow end to end.',
        tested: ['Password reset'],
        outcomes: [],
        concerns: [],
        ...report,
      },
    },
  } as Partial<PipelineStep>)
}

const spec: ServiceSpecView = {
  present: true,
  spec: {
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
              {
                id: 'req-reset',
                title: 'A user can reset their password',
                statement: 'The system SHALL send a reset link.',
                kind: 'functional',
                priority: 'must',
                state: 'aspirational',
                acceptance: [],
                sourceBlockIds: [],
              },
              {
                id: 'req-login',
                title: 'A user can sign in',
                statement: 'The system SHALL authenticate a user.',
                kind: 'functional',
                priority: 'must',
                state: 'established',
                acceptance: [],
                sourceBlockIds: [],
              },
            ],
          },
        ],
      },
    ],
  },
  features: [],
}

describe('composeRunOutcome', () => {
  it('carries the ask and every pull request so the diff stays one click away', () => {
    const outcome = composeRunOutcome({
      block: block({
        pullRequest: { url: 'https://host/pr/7', number: 7, branch: 'cat-factory/blk_1' },
        peerPullRequests: [{ repo: 'acme/api', ref: { url: 'https://host/api/pr/3', number: 3 } }],
      }),
      instance: null,
    })

    expect(outcome.title).toBe('Password reset')
    expect(outcome.ask).toBe('Let a signed-out user reset their password by email.')
    expect(outcome.disposition).toBe('awaiting_merge')
    expect(outcome.pullRequests).toEqual([
      { url: 'https://host/pr/7', number: 7, branch: 'cat-factory/blk_1', repo: null },
      { url: 'https://host/api/pr/3', number: 3, branch: null, repo: 'acme/api' },
    ])
  })

  it('distinguishes no tester step from a tester that has not reported', () => {
    const none = composeRunOutcome({ block: block(), instance: run([step()]) })
    expect(none.tests).toEqual({ status: 'absent', gap: 'no_tester_step' })
    expect(none.requirements).toEqual({ status: 'absent', gap: 'no_tester_step' })

    const silent = composeRunOutcome({
      block: block(),
      instance: run([step({ agentKind: 'tester-api' })]),
    })
    expect(silent.tests).toEqual({ status: 'absent', gap: 'tester_not_reported' })
  })

  it('keeps a tester that could not run apart from one that raised concerns', () => {
    const aborted = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({
          greenlight: false,
          abort: { reason: 'The preview environment never came up.' },
        }),
      ]),
    })
    expect(aborted.tests).toMatchObject({
      status: 'reported',
      verdict: 'could_not_run',
      abortReason: 'The preview environment never came up.',
      concerns: [],
    })

    const buggy = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({
          greenlight: false,
          concerns: [{ title: 'Reset link expires immediately', detail: '…', severity: 'high' }],
          outcomes: [
            { name: 'Reset', status: 'failed' },
            { name: 'Login', status: 'passed' },
            { name: 'Rate limit', status: 'skipped' },
          ],
        }),
      ]),
    })
    expect(buggy.tests).toMatchObject({
      verdict: 'concerns',
      passed: 1,
      failed: 1,
      skipped: 1,
      concerns: [{ title: 'Reset link expires immediately', severity: 'high' }],
    })
  })

  it('reports a failing ESTABLISHED requirement as a regression and an aspirational one as not', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({
          requirementVerdicts: [
            { requirementId: 'req-reset', status: 'not_met', detail: 'Not built yet.' },
            { requirementId: 'req-login', status: 'not_met', detail: 'Sign-in now 500s.' },
          ],
        }),
      ]),
      spec,
    })

    expect(outcome.requirements).toMatchObject({
      status: 'reported',
      spec: 'joined',
      regressions: 1,
    })
    if (outcome.requirements.status !== 'reported') throw new Error('expected a reported section')
    // The regression leads, and both are still counted as failures.
    expect(outcome.requirements.entries.map((e) => [e.id, e.regression])).toEqual([
      ['req-login', true],
      ['req-reset', false],
    ])
    expect(outcome.requirements.notMet).toBe(2)
    expect(outcome.requirements.entries[0]?.title).toBe('A user can sign in')
  })

  // Coverage is counted over the SPEC, not over what the tester chose to rule on: a requirement
  // nobody looked at has to appear as unchecked, or the one number a reader takes away ("2 of 2
  // met") is computed over a denominator the tester picked for itself.
  it('counts a requirement nobody ruled on as not covered rather than leaving it out', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({ requirementVerdicts: [{ requirementId: 'req-login', status: 'met' }] }),
      ]),
      spec,
    })
    if (outcome.requirements.status !== 'reported') throw new Error('expected a reported section')
    expect(outcome.requirements).toMatchObject({ met: 1, notCovered: 1, total: 2 })
    expect(outcome.requirements.entries.map((e) => e.id)).toEqual(['req-login', 'req-reset'])
  })

  // Every tester step's verdicts count, not just the reporting one's: the rule the PR
  // verification report already followed while this summary read only the last tester.
  it('joins the verdicts of every tester step in the pipeline', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep(
          { requirementVerdicts: [{ requirementId: 'req-login', status: 'met' }] },
          'tester-api',
        ),
        testerStep(
          { requirementVerdicts: [{ requirementId: 'req-reset', status: 'met' }] },
          'tester-ui',
        ),
      ]),
      spec,
    })
    expect(outcome.requirements).toMatchObject({ met: 2, notCovered: 0, total: 2 })
  })

  it('says the spec was never read rather than rendering ids as titles', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({ requirementVerdicts: [{ requirementId: 'req-reset', status: 'met' }] }),
      ]),
    })
    expect(outcome.requirements).toMatchObject({ status: 'reported', spec: 'not_read' })
    if (outcome.requirements.status !== 'reported') throw new Error('expected a reported section')
    expect(outcome.requirements.entries[0]).toMatchObject({
      id: 'req-reset',
      title: null,
      state: null,
      regression: false,
    })
  })

  // A verdict against an id the spec does not carry has no row to land on. Dropped silently it
  // makes the section report fewer rulings than the tester made, which reads as a miscount rather
  // than as the two real causes: a spec rewritten under the tester, or a tester keying its
  // verdicts by something else.
  it('counts the verdicts the spec could not place instead of dropping them', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({
          requirementVerdicts: [
            { requirementId: 'req-login', status: 'met' },
            { requirementId: 'req-gone', status: 'met' },
          ],
        }),
      ]),
      spec,
    })
    expect(outcome.requirements).toMatchObject({
      status: 'reported',
      spec: 'joined',
      met: 1,
      unmatchedVerdicts: 1,
    })
  })

  it('separates a tester report with no verdicts from a tester that never reported', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([testerStep({ requirementVerdicts: [] })]),
    })
    expect(outcome.requirements).toEqual({ status: 'absent', gap: 'no_verdicts' })
  })

  // With a spec to count against, a tester that ruled on nothing is not an absence: every
  // requirement is unchecked, which is a stronger statement than a blank section and the one the
  // PR verification report already makes.
  it('reports a full spec of unchecked requirements when the tester ruled on none', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([testerStep({ requirementVerdicts: [] })]),
      spec,
    })
    expect(outcome.requirements).toMatchObject({
      status: 'reported',
      spec: 'joined',
      notCovered: 2,
      total: 2,
    })
  })

  it('says a spec that records no requirements had nothing to rule on', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({ requirementVerdicts: [{ requirementId: 'req-reset', status: 'met' }] }),
      ]),
      spec: {
        present: true,
        spec: { service: 'accounts', summary: '', modules: [] },
        features: [],
      },
    })
    expect(outcome.requirements).toEqual({ status: 'absent', gap: 'no_requirements' })
  })

  it('prefers the reviewed visual-confirmation pairs over the tester’s raw captures', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        testerStep({ screenshots: [{ view: 'reset', artifactId: 'art_shot' }] }),
        step({
          agentKind: 'visual-confirmation',
          visualConfirm: {
            phase: 'approved',
            attempts: 0,
            maxAttempts: 2,
            pairs: [{ view: 'reset', actualArtifactId: 'art_a', referenceArtifactId: 'art_ref' }],
          },
        } as Partial<PipelineStep>),
      ]),
    })
    expect(outcome.visuals).toEqual({
      status: 'reported',
      source: 'visual_confirm',
      phase: 'approved',
      views: [{ view: 'reset', artifactId: 'art_a', referenceArtifactId: 'art_ref' }],
    })
  })

  it('falls back to the tester’s captures, and says which gap it hit when there are none', () => {
    const captured = composeRunOutcome({
      block: block(),
      instance: run([testerStep({ screenshots: [{ view: 'reset', artifactId: 'art_shot' }] })]),
    })
    expect(captured.visuals).toMatchObject({ status: 'reported', source: 'tester', phase: null })

    // An API tester captures nothing by design: no producer, so nothing was ever meant to be seen.
    const apiOnly = composeRunOutcome({
      block: block(),
      instance: run([testerStep({}, 'tester-api')]),
    })
    expect(apiOnly.visuals).toEqual({ status: 'absent', gap: 'no_visual_step', detail: null })

    // A gate that ran and gathered nothing is a different fact, and it recorded why.
    const degraded = composeRunOutcome({
      block: block(),
      instance: run([
        step({
          agentKind: 'visual-confirmation',
          visualConfirm: {
            phase: 'awaiting_human',
            attempts: 0,
            maxAttempts: 2,
            pairs: [],
            degradedReason: 'No artifact storage configured.',
          },
        } as Partial<PipelineStep>),
      ]),
    })
    expect(degraded.visuals).toEqual({
      status: 'absent',
      gap: 'none_captured',
      detail: 'No artifact storage configured.',
    })
  })

  it('lists only the checks that actually recorded a verdict', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({
          agentKind: 'ci',
          gate: { phase: 'checking', attempts: 0, maxAttempts: 3 },
        } as Partial<PipelineStep>),
        step({
          validation: { passed: false, attempts: 2, maxAttempts: 3, outcomes: [] },
        } as Partial<PipelineStep>),
        step({
          reproduction: {
            status: 'inconclusive',
            command: 'pnpm test',
            testPaths: [],
            attempts: 1,
            maxAttempts: 2,
            at: 1,
          },
        } as Partial<PipelineStep>),
      ]),
    })

    // The CI gate has not probed yet, so it contributes NOTHING rather than a green row.
    expect(outcome.checks).toEqual([
      { kind: 'validation', state: 'fail', reproduction: null },
      { kind: 'reproduction', state: 'inconclusive', reproduction: 'inconclusive' },
    ])
  })

  it('reads the CI gate’s recorded verdict once it has probed', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({
          agentKind: 'ci',
          gate: { phase: 'checking', attempts: 0, maxAttempts: 3, lastVerdict: 'pass' },
        } as Partial<PipelineStep>),
      ]),
    })
    expect(outcome.checks).toEqual([{ kind: 'ci', state: 'pass', reproduction: null }])
  })

  // A block that NAMES a run the caller could not resolve is the trap this whole module is
  // about: composed from the empty step list it would report a pipeline that ran and produced
  // nothing, which is the opposite of "nobody could read what it produced".
  it('says the run could not be read rather than blaming the pipeline for the missing steps', () => {
    const outcome = composeRunOutcome({
      block: block({ status: 'done', executionId: 'exe_gone' }),
      instance: null,
    })

    expect(outcome.requirements).toEqual({ status: 'absent', gap: 'run_unavailable' })
    expect(outcome.tests).toEqual({ status: 'absent', gap: 'run_unavailable' })
    expect(outcome.visuals).toEqual({ status: 'absent', gap: 'run_unavailable', detail: null })
    expect(outcome.checks).toEqual([])
    // The block still carries what the block knows.
    expect(outcome.disposition).toBe('merged')
    expect(outcome.title).toBe('Password reset')
  })

  it('keeps a task that never ran apart from one whose run could not be read', () => {
    const never = composeRunOutcome({ block: block({ status: 'ready' }), instance: null })
    const unread = composeRunOutcome({
      block: block({ status: 'ready', executionId: 'exe_gone' }),
      instance: null,
    })

    expect(never.disposition).toBe('not_run')
    expect(never.tests).toEqual({ status: 'absent', gap: 'no_tester_step' })
    expect(unread.disposition).toBe('unknown')
    expect(unread.tests).toEqual({ status: 'absent', gap: 'run_unavailable' })
  })

  // The selected tester is the one that REPORTED, which can be the api half of a pipeline whose
  // ui half has not. Reading the producer off it would tell a reader looking at a UI pipeline
  // that nothing in it captures the interface.
  it('finds the interface producer anywhere in the pipeline, not only on the reporting tester', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({ agentKind: 'tester-ui' }),
        testerStep({ screenshots: [] }, 'tester-api'),
      ]),
    })
    expect(outcome.visuals).toEqual({ status: 'absent', gap: 'none_captured', detail: null })
  })

  it('derives the disposition from the block, and from the run only where the block cannot', () => {
    const dispositions = [
      composeRunOutcome({ block: block({ status: 'done' }), instance: null }).disposition,
      composeRunOutcome({ block: block({ status: 'pr_ready' }), instance: null }).disposition,
      composeRunOutcome({ block: block({ status: 'planned' }), instance: null }).disposition,
      composeRunOutcome({ block: block({ status: 'in_progress' }), instance: run([step()]) })
        .disposition,
      composeRunOutcome({
        block: block({ status: 'in_progress' }),
        instance: run([step()], { status: 'failed' }),
      }).disposition,
      // `in_progress` is the block's own word for a live run, so it stands with no instance.
      composeRunOutcome({
        block: block({ status: 'in_progress', executionId: 'exe_gone' }),
        instance: null,
      }).disposition,
    ]
    expect(dispositions).toEqual([
      'merged',
      'awaiting_merge',
      'not_run',
      'in_flight',
      'needs_attention',
      'in_flight',
    ])
  })
})

describe('hasOutcomeToShow', () => {
  it('is false for a run that has produced nothing to read yet', () => {
    expect(
      hasOutcomeToShow(composeRunOutcome({ block: block({ status: 'planned' }), instance: null })),
    ).toBe(false)
  })

  // The affordance the board card and the inspector both gate on: a task marked done by hand,
  // carrying no pull request and no readable run, has nothing an outcome card could show.
  it('is false for a task whose run cannot be read and which carries no pull request', () => {
    expect(
      hasOutcomeToShow(
        composeRunOutcome({
          block: block({ status: 'done', executionId: 'exe_gone' }),
          instance: null,
        }),
      ),
    ).toBe(false)
  })

  it('is true as soon as there is a PR or any recorded evidence', () => {
    expect(
      hasOutcomeToShow(
        composeRunOutcome({
          block: block({ pullRequest: { url: 'https://host/pr/7', number: 7 } }),
          instance: null,
        }),
      ),
    ).toBe(true)
    expect(
      hasOutcomeToShow(
        composeRunOutcome({
          block: block({ status: 'in_progress' }),
          instance: run([testerStep({})]),
        }),
      ),
    ).toBe(true)
  })
})
