import type { ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { PR_REPORT_MAX_OUTPUT_CHARS } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  composeReproduction,
  composeValidation,
  makeOutputCapper,
  renderReproduction,
  renderValidation,
} from './prReport.commands.js'

// The two CAPTURED-OUTPUT sections of the PR verification report. What is asserted here is
// specifically the honesty of the rendering: that an absence names its cause, that a bounded log
// says it was bounded, that a fence cannot be broken out of by the log's own backticks, and that
// each verdict shape reaches a reviewer as the thing it actually is.

function step(partial: Partial<PipelineStep> & { agentKind: string }): PipelineStep {
  return { state: 'done', progress: 1, decision: null, ...partial } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_bugfix',
    pipelineName: 'Triage & fix bug',
    steps,
    currentStep: steps.length - 1,
    status: 'done',
  } as ExecutionInstance
}

/** The caps the report's spine hands in, over a truncation log the case can inspect. */
function caps(truncations: string[] = []) {
  return {
    truncations,
    caps: {
      cap: <T>(items: readonly T[]): T[] => [...items],
      output: makeOutputCapper(truncations),
    },
  }
}

const VALIDATION = {
  passed: false,
  attempts: 2,
  maxAttempts: 3,
  at: 1_700_000_000_000,
  outcomes: [
    { label: 'lint', command: 'pnpm lint', exitCode: 0, passed: true, outputTail: 'all clean' },
    {
      label: 'test',
      command: 'pnpm test',
      exitCode: 1,
      passed: false,
      outputTail: '1 failed, 42 passed',
      durationMs: 4_200,
    },
  ],
}

describe('composeValidation', () => {
  it('names the causes of an absent section rather than leaving it blank', () => {
    const { caps: c } = caps()
    const section = composeValidation(instance([step({ agentKind: 'coder' })]), c)

    expect(section.status).toBe('absent')
    // Both remaining causes are named: the report only ever publishes onto an EXISTING pull
    // request, so "the run never got that far" is not one of them, but "an older runner image"
    // is — and asserting only the configuration cause would be a fabricated fact about a setup.
    expect(section.note).toContain('no check commands')
    expect(section.note).toContain('runner image')
    expect(section.commands).toEqual([])
    expect(section.configUnreadable).toBeUndefined()
  })

  it('refuses to call an UNREADABLE configuration an unconfigured one', () => {
    const { caps: c } = caps()
    const section = composeValidation(
      instance([step({ agentKind: 'coder', validationConfigUnreadable: true })]),
      c,
    )

    expect(section.status).toBe('absent')
    expect(section.configUnreadable).toBe(true)
    // The claim it would otherwise make is a fabricated fact about somebody's setup: the service
    // may configure several checks that this run never got to see. So the note is DISPLACED, not
    // qualified: a reader who skims must not come away with the wrong one of the two.
    expect(section.note).toContain('could not READ')
    expect(section.note).not.toContain('configures no check commands')
  })

  it('bounds what a REPORTED section covers when a later read failed', () => {
    const { caps: c } = caps()
    const section = composeValidation(
      instance([
        step({ agentKind: 'coder', validation: VALIDATION }),
        step({ agentKind: 'ci-fixer', validationConfigUnreadable: true }),
      ]),
      c,
    )

    // The evidence stands (it was captured), but it no longer describes every dispatch on the
    // run, and the failing read is by construction on a step that produced no evidence, which
    // is why the scan is over all steps rather than the one the section reports off.
    expect(section.status).toBe('reported')
    expect(section.configUnreadable).toBe(true)
    expect(section.commands).toHaveLength(2)
  })

  it('retains a FAILING command’s log and drops a passing one’s', () => {
    const { caps: c } = caps()
    const section = composeValidation(
      instance([step({ agentKind: 'coder', validation: VALIDATION })]),
      c,
    )

    expect(section.status).toBe('reported')
    expect(section.passed).toBe(false)
    expect(section.stepKind).toBe('coder')
    expect(section.attempts).toBe(2)
    // The green check keeps its exit code and loses its log: ten of those would cost the budget
    // that makes the red one readable, and the section says so in as many words.
    expect(section.commands[0]).toMatchObject({ label: 'lint', passed: true, outputTail: null })
    expect(section.commands[1]).toMatchObject({ label: 'test', outputTail: '1 failed, 42 passed' })
  })

  it('bounds a long log from the END and records the cut', () => {
    const { caps: c, truncations } = caps()
    const tail = `${'x'.repeat(PR_REPORT_MAX_OUTPUT_CHARS * 2)}THE ASSERTION`
    const section = composeValidation(
      instance([
        step({
          agentKind: 'coder',
          validation: {
            ...VALIDATION,
            outcomes: [{ ...VALIDATION.outcomes[1]!, outputTail: tail }],
          },
        }),
      ]),
      c,
    )

    // A prefix cut would throw away exactly the half a reviewer opened the report for.
    expect(section.commands[0]!.outputTail).toContain('THE ASSERTION')
    expect(section.commands[0]!.outputTail!.length).toBe(PR_REPORT_MAX_OUTPUT_CHARS)
    expect(truncations.join(' ')).toContain('showing the last')
  })
})

describe('renderValidation', () => {
  it('fences a log the log itself cannot break out of', () => {
    const { caps: c } = caps()
    const section = composeValidation(
      instance([
        step({
          agentKind: 'coder',
          validation: {
            ...VALIDATION,
            outcomes: [
              { ...VALIDATION.outcomes[1]!, outputTail: 'error in ```const x = 1``` at line 3' },
            ],
          },
        }),
      ]),
      c,
    )
    const rendered = renderValidation(section).join('\n')

    // A fixed ``` fence would close on the log's own run and spill everything after it — the rest
    // of the report, and the machine-readable JSON block — into the body as prose.
    expect(rendered).toContain('````\nerror in ```const x = 1``` at line 3\n````')
    expect(rendered).toContain('retained for FAILING commands only')
  })

  it('states the absent cause instead of rendering an empty table', () => {
    const { caps: c } = caps()
    const rendered = renderValidation(
      composeValidation(instance([step({ agentKind: 'coder' })]), c),
    ).join('\n')

    expect(rendered).toContain('Pre-PR validation')
    expect(rendered).toContain('no check commands')
    expect(rendered).not.toContain('| Check |')
  })

  it('warns above the table when the evidence does not cover every dispatch', () => {
    const { caps: c } = caps()
    const rendered = renderValidation(
      composeValidation(
        instance([
          step({ agentKind: 'coder', validation: VALIDATION }),
          step({ agentKind: 'ci-fixer', validationConfigUnreadable: true }),
        ]),
        c,
      ),
    ).join('\n')

    // Above the verdict, not below the table: a reader who stops at the green ✅ is exactly the
    // one this line exists for.
    expect(rendered.indexOf('could not read')).toBeLessThan(rendered.indexOf('**Verdict:**'))
    expect(rendered).toContain('| Check |')
  })
})

const REPRODUCED = {
  status: 'reproduced' as const,
  command: 'pnpm vitest run src/auth/login.test.ts',
  testPaths: ['src/auth/login.test.ts'],
  base: { exitCode: 1, passed: false, outputTail: 'expected 200, got 401', durationMs: 900 },
  final: { exitCode: 0, passed: true, outputTail: '1 passed', durationMs: 850 },
  attempts: 1,
  maxAttempts: 3,
  at: 1_700_000_000_000,
}

describe('composeReproduction', () => {
  it('distinguishes a pipeline with no reproduction step from one that recorded no proof', () => {
    const { caps: c } = caps()
    const none = composeReproduction(instance([step({ agentKind: 'coder' })]), c)
    const declared = composeReproduction(
      instance([step({ agentKind: 'repro-test' }), step({ agentKind: 'coder' })]),
      c,
    )

    // Two different things to fix: the pipeline is wrong for the task, versus the phase was off
    // or the declaration named no runnable command.
    expect(none.note).toContain('No reproduction step in this pipeline')
    expect(declared.note).toContain('not enabled for this task')
  })

  it('keeps BOTH trees’ logs, whatever they did', () => {
    const { caps: c } = caps()
    const section = composeReproduction(
      instance([step({ agentKind: 'coder', reproduction: REPRODUCED })]),
      c,
    )

    expect(section.verdict).toBe('reproduced')
    // Only a human reading both logs can see whether the pre-fix tree was red for the RIGHT
    // reason — the one thing the symmetric-worktree design deliberately does not claim to detect.
    expect(section.base?.outputTail).toBe('expected 200, got 401')
    expect(section.final?.outputTail).toBe('1 passed')
  })
})

describe('renderReproduction', () => {
  it('renders red-then-green as the proof it is', () => {
    const { caps: c } = caps()
    const rendered = renderReproduction(
      composeReproduction(instance([step({ agentKind: 'coder', reproduction: REPRODUCED })]), c),
    ).join('\n')

    expect(rendered).toContain('reproduced')
    expect(rendered).toContain('FAILED on the pre-fix tree')
    expect(rendered).toContain('Pre-fix tree output')
    expect(rendered).toContain('Final tree output')
  })

  it('explains an absent FINAL run rather than rendering it as missing data', () => {
    const { caps: c } = caps()
    const rendered = renderReproduction(
      composeReproduction(
        instance([
          step({
            agentKind: 'coder',
            reproduction: {
              ...REPRODUCED,
              status: 'inconclusive',
              base: { exitCode: 0, passed: true },
              final: undefined,
              note: 'The check passed on the pre-fix tree; the reproduction may not capture the defect.',
            },
          }),
        ]),
        c,
      ),
    ).join('\n')

    // A green base SETTLES the verdict, so the second tree is deliberately not run.
    expect(rendered).toContain('already settled the verdict')
    // The producer's own diagnosis is rendered verbatim: only the side that ran can tell a test
    // that misses the defect from a resumed run whose pre-fix tree carried its own work.
    expect(rendered).toContain('may not capture the defect')
  })

  it('renders a concede with its reason and what was verified instead', () => {
    const { caps: c } = caps()
    const rendered = renderReproduction(
      composeReproduction(
        instance([
          step({
            agentKind: 'coder',
            reproduction: {
              status: 'declared_infeasible',
              command: '',
              testPaths: [],
              attempts: 0,
              maxAttempts: 0,
              reason: 'Needs production traffic volume.',
              alternativeVerification: 'Traced the refresh path against the reported request ids.',
              at: 1_700_000_000_000,
            },
          }),
        ]),
        c,
      ),
    ).join('\n')

    expect(rendered).toContain('declared infeasible')
    expect(rendered).toContain('production traffic volume')
    expect(rendered).toContain('Traced the refresh path')
    // Nothing ran, so there are no trees to tabulate.
    expect(rendered).not.toContain('| Tree |')
  })

  it('says when declared test paths were dropped before the proof ran', () => {
    const { caps: c } = caps()
    const rendered = renderReproduction(
      composeReproduction(
        instance([
          step({
            agentKind: 'coder',
            reproduction: { ...REPRODUCED, status: 'inconclusive', omittedTestPaths: 2 },
          }),
        ]),
        c,
      ),
    ).join('\n')

    // A dropped path can leave the pre-fix tree without the reproduction, which greens it and
    // reads as "the test does not capture the defect".
    expect(rendered).toContain('2 declared test paths were dropped')
    expect(rendered).toContain('incomplete reproduction')
  })
})

describe('what the validation section CLAIMS about the tree it ran on', () => {
  function rendered(passed: boolean): string {
    const { caps: c } = caps()
    return renderValidation(
      composeValidation(
        instance([
          step({
            agentKind: 'coder',
            validation: {
              ...VALIDATION,
              passed,
              outcomes: [{ ...VALIDATION.outcomes[0]!, passed, exitCode: passed ? 0 : 1 }],
            },
          }),
        ]),
        c,
      ),
    ).join('\n')
  }

  it('claims the PR’s own tree only when the checks actually passed', () => {
    expect(rendered(true)).toContain('in the checkout that opened this pull request')
  })

  it('says the opposite when they did not, because a red attempt opens no PR', () => {
    // The report publishes onto an EXISTING pull request, so a red section means some earlier
    // dispatch opened it. Claiming this tree did would be the report asserting exactly the kind
    // of unchecked thing it exists to stop an agent asserting.
    const red = rendered(false)
    expect(red).toContain('in the checkout it validated')
    expect(red).toContain('not the tree this one was opened from')
    expect(red).not.toContain('in the checkout that opened this pull request')
  })
})

describe('an estimate-SKIPPED reproduction step', () => {
  // `repro-test` is gatable (see `BUILTIN_GATABLE_KINDS`), so a pipeline may skip it on a task
  // that scored below its threshold. Gating leaves the step in `instance.steps` carrying
  // `skipped`, which is what makes this reachable at all, and what would otherwise let it read as
  // the un-opted-in case.
  function note(steps: PipelineStep[]): string {
    const { caps: c } = caps()
    return composeReproduction(instance(steps), c).note ?? ''
  }

  it('names the skip rather than blaming the phase being off', () => {
    const skipped = note([
      step({ agentKind: 'repro-test', skipped: true } as Partial<PipelineStep> & {
        agentKind: string
      }),
      step({ agentKind: 'coder' }),
    ])

    // Two different operator fixes: a gating threshold on the pipeline, versus looking at what
    // the reproduction step itself produced.
    expect(skipped).toContain('was skipped')
    expect(skipped).toContain('below the threshold')
    expect(skipped).not.toContain('not enabled for this task')
  })

  it('still reports the un-opted-in cause when the step RAN and recorded nothing', () => {
    expect(note([step({ agentKind: 'repro-test' }), step({ agentKind: 'coder' })])).toContain(
      'not enabled for this task',
    )
  })
})
