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
})

// The REQUIREMENT COVERAGE half, split out to keep each describe within the per-function line
// budget (see CLAUDE.md: split, never raise). It is the section with the most states by a wide
// margin, because a coverage number carries three separate questions: which tester steps were
// read, what the count was taken OVER, and what the spec could not place.
describe('composeRunOutcome: requirement coverage', () => {
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
      instance: run([testerStep({ requirementVerdicts: [] })]),
      spec: {
        present: true,
        spec: { service: 'accounts', summary: '', modules: [] },
        features: [],
      },
    })
    expect(outcome.requirements).toEqual({ status: 'absent', gap: 'no_requirements' })
  })

  it('keeps the tester’s verdicts when the spec declares nothing to match them against', () => {
    // The spec moved on under the run (or the tester keyed its verdicts by something else).
    // Reporting this as `no_requirements` would say "there was nothing for the tester to rule
    // on" while discarding the ruling it made, which is the one thing this section exists to
    // prevent.
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
    expect(outcome.requirements).toEqual({
      status: 'reported',
      spec: 'joined',
      met: 0,
      notMet: 0,
      notCovered: 0,
      regressions: 0,
      total: 0,
      unmatchedVerdicts: 1,
      entries: [],
    })
  })
})

// What the run LOOKED like, what the machines checked, and where the summary stands. Split from
// the coverage half above for the same line-budget reason, along the same seam the card renders.
describe('composeRunOutcome: visuals, checks and disposition', () => {
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

  it('reports an absence when the gate’s rows are all reference, never a verified gallery', () => {
    // A task linking a design (or carrying an uploaded mock) gets a gate row per reference view
    // whether or not anything was captured against it. Counting rows would report this run's
    // visuals as verified and render a gallery whose every `artifactId` is null.
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({
          agentKind: 'visual-confirmation',
          visualConfirm: {
            phase: 'awaiting_human',
            attempts: 0,
            maxAttempts: 2,
            pairs: [
              { view: 'Checkout', actualArtifactId: null, referenceArtifactId: 'art_frame' },
              { view: 'Confirm', actualArtifactId: null, referenceArtifactId: 'art_frame2' },
            ],
            degradedReason: 'No UI screenshots were captured for this task.',
          },
        } as Partial<PipelineStep>),
      ]),
    })

    expect(outcome.visuals).toEqual({
      status: 'absent',
      gap: 'none_captured',
      detail: 'No UI screenshots were captured for this task.',
    })
  })

  it('keeps the reference-only rows once ANY view was captured', () => {
    // The opposite case: one real capture makes the gallery evidence, and the unpaired reference
    // rows beside it are part of what the human was shown.
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({
          agentKind: 'visual-confirmation',
          visualConfirm: {
            phase: 'approved',
            attempts: 0,
            maxAttempts: 2,
            pairs: [
              { view: 'Checkout', actualArtifactId: 'art_a', referenceArtifactId: 'art_frame' },
              { view: 'Confirm', actualArtifactId: null, referenceArtifactId: 'art_frame2' },
            ],
          },
        } as Partial<PipelineStep>),
      ]),
    })

    expect(outcome.visuals).toMatchObject({
      status: 'reported',
      source: 'visual_confirm',
      views: [
        { view: 'Checkout', artifactId: 'art_a', referenceArtifactId: 'art_frame' },
        { view: 'Confirm', artifactId: null, referenceArtifactId: 'art_frame2' },
      ],
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

describe('composeRunOutcome: what the run was built FROM', () => {
  const figma = (version: string) => ({
    externalId: 'f1',
    title: 'Checkout flow',
    url: 'https://figma.com/design/f1',
    origin: 'figma' as const,
    freshness: { status: 'confirmed' as const, version, change: 'unchanged' as const },
  })

  it('says no page was linked rather than showing an empty list', () => {
    const outcome = composeRunOutcome({ block: block(), instance: run([step()]) })
    expect(outcome.sources).toEqual({ status: 'absent', gap: 'none_linked' })
  })

  it('reduces a page read by several dispatches to one row, keeping the last verdict', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({ contextDocuments: [figma('v1')] }),
        step({ agentKind: 'merger', contextDocuments: [figma('v1')] }),
      ]),
    })
    const { externalId: _externalId, ...shown } = figma('v1')
    expect(outcome.sources.status === 'reported' && outcome.sources.sources).toEqual([
      { ...shown, movedDuringRun: false },
    ])
  })

  it('flags a page whose revision moved between two of the run’s own dispatches', () => {
    // The last revision alone reads as a run that built entirely against v2. The coder step
    // finished before the designer's edit, and that is the whole reason this flag exists.
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({ contextDocuments: [figma('v1')] }),
        step({ agentKind: 'merger', contextDocuments: [figma('v2')] }),
      ]),
    })
    const rows = outcome.sources.status === 'reported' ? outcome.sources.sources : []
    expect(rows[0]).toMatchObject({ movedDuringRun: true, freshness: { version: 'v2' } })
  })

  it('keeps a page nobody checked apart from one that was checked and could not be confirmed', () => {
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([
        step({
          contextDocuments: [
            { externalId: 'prd', title: 'PRD', url: 'https://notion.so/prd', origin: 'notion' },
            {
              externalId: 'f2',
              title: 'Design',
              url: 'https://figma.com/design/f2',
              origin: 'figma',
              freshness: { status: 'unconfirmed', reason: 'source_unreachable' },
            },
          ],
        }),
      ]),
    })
    const rows = outcome.sources.status === 'reported' ? outcome.sources.sources : []
    expect(rows[0]?.freshness).toBeNull()
    expect(rows[1]?.freshness).toMatchObject({ status: 'unconfirmed' })
  })

  it('keeps two same-titled uploads apart instead of reading them as one page that moved', () => {
    // An upload carries no URL, so title is the only thing a row SHOWS that could key it. Keying
    // on it would fold these into one row whose two revisions read as a design edited mid-run,
    // which is the single loudest thing this section says.
    const upload = (externalId: string, version: string) => ({
      externalId,
      title: 'Wireframes.pdf',
      url: '',
      origin: 'upload' as const,
      freshness: { status: 'confirmed' as const, version, change: 'unchanged' as const },
    })
    const outcome = composeRunOutcome({
      block: block(),
      instance: run([step({ contextDocuments: [upload('doc_a', 'v1'), upload('doc_b', 'v2')] })]),
    })
    const rows = outcome.sources.status === 'reported' ? outcome.sources.sources : []
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => !row.movedDuringRun)).toBe(true)
    // The URL an upload has no source for is null, never the empty string it is stored as.
    expect(rows.every((row) => row.url === null)).toBe(true)
  })

  it('reports the unresolved run rather than blaming the task for linking nothing', () => {
    const outcome = composeRunOutcome({
      block: block({ executionId: 'exe_gone' }),
      instance: null,
    })
    expect(outcome.sources).toEqual({ status: 'absent', gap: 'run_unavailable' })
  })
})

describe('composeRunOutcome: where to go and look', () => {
  // The section answers one question (is there something to click, and if not why not), so the
  // cases worth pinning are the ones where a wrong answer hands a designer a dead URL, or hides
  // a working one.

  const deployer = (
    envs: Record<string, Record<string, unknown>>,
    overrides: Partial<PipelineStep> = {},
  ): PipelineStep =>
    step({ agentKind: 'deployer', deployEnvs: envs, ...overrides } as Partial<PipelineStep>)

  const disposer = (envs: Record<string, Record<string, unknown>>): PipelineStep =>
    step({ agentKind: 'disposer', disposeEnvs: envs } as Partial<PipelineStep>)

  const projecting = (environment: Record<string, unknown>): PipelineStep =>
    step({ agentKind: 'tester-ui', environment } as Partial<PipelineStep>)

  function entries(instance: ExecutionInstance) {
    const { environments } = composeRunOutcome({ block: block(), instance })
    if (environments.status !== 'reported')
      throw new Error(`expected entries, got ${environments.gap}`)
    return environments.entries
  }

  it('reports the live URL of every frame that came up, and the cause of one that did not', () => {
    const rows = entries(
      run([
        deployer({
          frm_own: { status: 'ready', url: 'https://pr-7.preview.test', environmentId: 'env_1' },
          frm_peer: { status: 'failed', error: 'helm release timed out' },
        }),
      ]),
    )
    expect(rows).toEqual([
      {
        url: 'https://pr-7.preview.test',
        state: 'live',
        origin: 'deployer',
        expiresAt: null,
        retained: false,
        frameId: 'frm_own',
        environmentId: 'env_1',
        detail: null,
      },
      {
        url: null,
        state: 'failed',
        origin: 'deployer',
        expiresAt: null,
        retained: false,
        frameId: 'frm_peer',
        environmentId: null,
        detail: 'helm release timed out',
      },
    ])
  })

  // The deploy row is terminal at PROVISION time and never moves again, so reading it alone
  // reports a reclaimed environment as a working preview for as long as the run is readable.
  it('never reports a reclaimed environment as live, whoever took it', () => {
    const reclaimed = entries(
      run([
        deployer({ frm_own: { status: 'ready', url: 'https://x.test', environmentId: 'env_1' } }),
        disposer({
          frm_own: { status: 'reclaimed', environmentId: 'env_1', confirmation: 'confirmed' },
        }),
      ]),
    )
    expect(reclaimed[0]?.state).toBe('reclaimed')
    // The disposer went looking and found nothing live: also gone, and the reader's next move is
    // the same one.
    const alreadyGone = entries(
      run([
        deployer({ frm_own: { status: 'ready', url: 'https://x.test', environmentId: 'env_1' } }),
        disposer({ frm_own: { status: 'none' } }),
      ]),
    )
    expect(alreadyGone[0]?.state).toBe('reclaimed')
  })

  // The opposite collapse: a teardown the provider refused leaves the environment standing, and
  // its URL still works. That it should not be standing is the verification report's business.
  it('keeps an environment whose reclaim FAILED open, with the provider’s cause beside it', () => {
    const rows = entries(
      run([
        deployer({ frm_own: { status: 'ready', url: 'https://x.test', environmentId: 'env_1' } }),
        disposer({
          frm_own: {
            status: 'failed',
            environmentId: 'env_1',
            error: 'namespace stuck terminating',
          },
        }),
      ]),
    )
    expect(rows[0]).toMatchObject({
      state: 'live',
      url: 'https://x.test',
      detail: 'namespace stuck terminating',
    })
  })

  it('follows the step projection while the run is still watching the environment', () => {
    const rows = entries(
      run([
        deployer({ frm_own: { status: 'ready', url: 'https://x.test', environmentId: 'env_1' } }),
        projecting({ id: 'env_1', url: 'https://x.test', status: 'expired', expiresAt: 1_000 }),
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'expired', expiresAt: 1_000, origin: 'deployer' })
  })

  // The in-flight case: the deployer has not settled, so the only thing that knows an
  // environment exists is the projection. Going silent here loses the URL for exactly as long as
  // the run is live.
  it('reports an environment the run is running against before any frame has settled', () => {
    const rows = entries(
      run([projecting({ id: 'env_1', url: 'https://x.test', status: 'ready', expiresAt: 9_000 })]),
    )
    expect(rows).toEqual([
      {
        url: 'https://x.test',
        state: 'live',
        origin: 'projected',
        expiresAt: 9_000,
        retained: false,
        frameId: null,
        environmentId: 'env_1',
        detail: null,
      },
    ])
  })

  // Two producers naming one environment is one row. A deploy row predating `environmentId`
  // names its environment only by the URL it handed out, so that is the second key.
  it('lists one environment once, however many producers name it', () => {
    const byId = entries(
      run([
        deployer({ frm_own: { status: 'ready', url: 'https://x.test', environmentId: 'env_1' } }),
        step({
          agentKind: 'human-test',
          humanTest: { environment: { id: 'env_1', url: 'https://x.test', status: 'ready' } },
        } as Partial<PipelineStep>),
      ]),
    )
    expect(byId).toHaveLength(1)
    expect(byId[0]?.origin).toBe('deployer')
    const byUrl = entries(
      run([
        deployer({ frm_own: { status: 'ready', url: 'https://x.test' } }),
        projecting({ id: 'env_1', url: 'https://x.test', status: 'ready' }),
      ]),
    )
    expect(byUrl).toHaveLength(1)
  })

  it('reports a gate’s own environment, which no deployer frame keys', () => {
    const rows = entries(
      run([
        step({
          agentKind: 'human-test',
          humanTest: { environment: { id: 'env_h', url: 'https://h.test', status: 'ready' } },
        } as Partial<PipelineStep>),
      ]),
    )
    expect(rows).toEqual([
      {
        url: 'https://h.test',
        state: 'live',
        origin: 'human_test',
        expiresAt: null,
        retained: false,
        frameId: null,
        environmentId: 'env_h',
        detail: null,
      },
    ])
  })

  // What separates a preview a reviewer is meant to keep clicking from one still standing
  // because nobody reclaimed it.
  it('carries the deployer’s retention declaration onto the frames it provisioned', () => {
    const rows = entries(
      run([
        deployer({ frm_own: { status: 'ready', url: 'https://x.test', environmentId: 'env_1' } }, {
          stepOptions: { retainEnvironment: true },
        } as Partial<PipelineStep>),
      ]),
    )
    expect(rows[0]?.retained).toBe(true)
  })

  it('keeps the three ways there is nothing to open apart', () => {
    const gap = (instance: ExecutionInstance | null) => {
      const { environments } = composeRunOutcome({ block: block(), instance })
      return environments.status === 'absent' ? environments.gap : 'reported'
    }
    // Nothing in the pipeline provisions anything.
    expect(gap(run([step()]))).toBe('no_environment_step')
    // A deployer that has not recorded an outcome: it has not got that far, or the deployment
    // wires no provider.
    expect(gap(run([deployer({})]))).toBe('not_provisioned')
    // Every frame declared no environment of its own, which is not a failure to provision.
    expect(gap(run([deployer({ frm_own: { status: 'skipped' } })]))).toBe('infraless')
    // And the read that never happened is never blamed on the pipeline.
    expect(
      (() => {
        const { environments } = composeRunOutcome({
          block: block({ executionId: 'exe_gone' }),
          instance: null,
        })
        return environments.status === 'absent' ? environments.gap : 'reported'
      })(),
    ).toBe('run_unavailable')
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

  // A running preview of the change is worth opening before the run has produced anything else,
  // which is the whole point of putting it on this card.
  it('is true for a run whose only product so far is a live environment', () => {
    expect(
      hasOutcomeToShow(
        composeRunOutcome({
          block: block({ status: 'in_progress' }),
          instance: run([
            step({
              agentKind: 'deployer',
              deployEnvs: { frm_own: { status: 'ready', url: 'https://x.test' } },
            } as Partial<PipelineStep>),
          ]),
        }),
      ),
    ).toBe(true)
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
