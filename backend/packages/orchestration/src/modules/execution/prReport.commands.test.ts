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
