import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '@cat-factory/kernel'
import {
  applyReproductionReport,
  concededReproductionReport,
  recordReproductionOutcome,
  reproductionDeclarationFrom,
  resolveReproductionSpec,
  resolveReproductionTriState,
} from './reproductionProof.logic.js'

// Unit coverage for the pure reproduction-proof resolution. The rules under test are the ones
// that decide whether a run pays for a verification phase at all, so each "returns undefined"
// case is a compatibility guarantee, not an edge case.

const step = (over: Partial<PipelineStep>): PipelineStep =>
  ({ agentKind: 'coder', status: 'pending', ...over }) as PipelineStep

const reproStep = (custom: unknown): PipelineStep => step({ agentKind: 'repro-test', custom })

const fullDeclaration = {
  outcome: 'reproduced',
  testPaths: ['a.test.ts'],
  command: 'pnpm vitest run a.test.ts',
}

describe('resolveReproductionTriState', () => {
  it('defaults to auto and degrades an unknown value rather than throwing', () => {
    expect(resolveReproductionTriState(undefined)).toBe('auto')
    expect(resolveReproductionTriState({})).toBe('auto')
    // An agent-config bag is free-form JSON — a stale or hand-edited value must not wedge a run.
    expect(resolveReproductionTriState({ 'coder.reproductionProof': 'nonsense' })).toBe('auto')
  })

  it('honours the explicit choices', () => {
    expect(resolveReproductionTriState({ 'coder.reproductionProof': 'off' })).toBe('off')
    expect(resolveReproductionTriState({ 'coder.reproductionProof': 'always' })).toBe('always')
  })
})

describe('reproductionDeclarationFrom', () => {
  it('reads the LAST reproduction step before the current one', () => {
    const steps = [
      reproStep({ ...fullDeclaration, command: 'first' }),
      reproStep({ ...fullDeclaration, command: 'second' }),
      step({}),
    ]
    // A retried reproduction step is the one describing the branch as it now stands.
    expect(reproductionDeclarationFrom(steps, 2)?.command).toBe('second')
  })

  it('ignores reproduction steps at or after the current index', () => {
    const steps = [step({}), reproStep(fullDeclaration)]
    expect(reproductionDeclarationFrom(steps, 1)).toBeUndefined()
  })

  it('returns undefined when no reproduction step ran', () => {
    expect(reproductionDeclarationFrom([step({}), step({})], 2)).toBeUndefined()
  })
})

describe('resolveReproductionSpec', () => {
  const base = { agentConfig: undefined, currentStep: 1 }

  it('resolves the declared command, paths and setup for the coder', () => {
    const spec = resolveReproductionSpec({
      ...base,
      agentKind: 'coder',
      steps: [reproStep({ ...fullDeclaration, setupCommand: 'pnpm i' })],
      maxAttempts: 5,
    })
    expect(spec).toEqual({
      command: 'pnpm vitest run a.test.ts',
      testPaths: ['a.test.ts'],
      setupCommand: 'pnpm i',
      maxAttempts: 5,
    })
  })

  it('trims and drops empty declared paths', () => {
    const spec = resolveReproductionSpec({
      ...base,
      agentKind: 'coder',
      steps: [reproStep({ ...fullDeclaration, testPaths: ['  a.test.ts ', '', '   '] })],
    })
    expect(spec?.testPaths).toEqual(['a.test.ts'])
  })

  // Every case below must yield `undefined` — no context field ⇒ no job-body field ⇒ the
  // harness's pre-feature path. This is the feature's core compatibility promise.
  it.each([
    [
      'the tri-state is off',
      {
        agentKind: 'coder',
        agentConfig: { 'coder.reproductionProof': 'off' },
        steps: [reproStep(fullDeclaration)],
      },
    ],
    [
      'the dispatched kind is not the PR-opening producer',
      { agentKind: 'reviewer', agentConfig: undefined, steps: [reproStep(fullDeclaration)] },
    ],
    ['no declaration exists', { agentKind: 'coder', agentConfig: undefined, steps: [step({})] }],
    [
      'the declaration conceded',
      {
        agentKind: 'coder',
        agentConfig: undefined,
        steps: [reproStep({ outcome: 'not_reproducible', testPaths: [], command: 'x' })],
      },
    ],
    [
      'the declaration named no command',
      {
        agentKind: 'coder',
        agentConfig: undefined,
        steps: [reproStep({ outcome: 'reproduced', testPaths: ['a.test.ts'] })],
      },
    ],
    [
      'the declared command is blank',
      {
        agentKind: 'coder',
        agentConfig: undefined,
        steps: [reproStep({ ...fullDeclaration, command: '   ' })],
      },
    ],
  ])('returns undefined when %s', (_label, args) => {
    expect(resolveReproductionSpec({ ...args, currentStep: 1 })).toBeUndefined()
  })

  it('still resolves for a partial reproduction (worth proving)', () => {
    const spec = resolveReproductionSpec({
      ...base,
      agentKind: 'coder',
      steps: [reproStep({ ...fullDeclaration, outcome: 'partial' })],
    })
    expect(spec?.command).toBe('pnpm vitest run a.test.ts')
  })
})

describe('concededReproductionReport', () => {
  it('renders a concede as a structural declaration with reason + alternative', () => {
    const report = concededReproductionReport(
      [
        reproStep({
          outcome: 'not_reproducible',
          testPaths: [],
          notes: '  Needs production data.  ',
          alternativeVerification: '  Traced the failing request ids.  ',
        }),
      ],
      1,
      42,
    )
    expect(report).toEqual({
      status: 'declared_infeasible',
      command: '',
      testPaths: [],
      attempts: 0,
      maxAttempts: 0,
      reason: 'Needs production data.',
      alternativeVerification: 'Traced the failing request ids.',
      at: 42,
    })
  })

  it('is undefined for a run that reproduced, or that never declared', () => {
    expect(concededReproductionReport([reproStep(fullDeclaration)], 1, 0)).toBeUndefined()
    expect(concededReproductionReport([step({})], 1, 0)).toBeUndefined()
  })
})

describe('applyReproductionReport', () => {
  const report = {
    status: 'reproduced',
    command: 'c',
    testPaths: [],
    base: { exitCode: 1, passed: false },
    final: { exitCode: 0, passed: true },
    attempts: 1,
    maxAttempts: 3,
    at: 10,
  }

  it('folds a report onto the step and reports the change', () => {
    const s = step({})
    expect(applyReproductionReport(s, report)).toBe(true)
    expect(s.reproduction?.status).toBe('reproduced')
  })

  it('is a no-op for an absent or unparseable payload (evidence, never a control signal)', () => {
    const s = step({})
    expect(applyReproductionReport(s, undefined)).toBe(false)
    expect(applyReproductionReport(s, null)).toBe(false)
    expect(s.reproduction).toBeUndefined()
  })

  it('does not churn on an idle poll re-offering the same report', () => {
    const s = step({})
    expect(applyReproductionReport(s, report)).toBe(true)
    expect(applyReproductionReport(s, { ...report })).toBe(false)
  })

  it('applies a NEW publish that changes the verdict', () => {
    const s = step({})
    applyReproductionReport(s, report)
    expect(applyReproductionReport(s, { ...report, attempts: 2, at: 20 })).toBe(true)
    expect(s.reproduction?.attempts).toBe(2)
  })
})

describe('recordReproductionOutcome', () => {
  const conceded = reproStep({
    outcome: 'not_reproducible',
    testPaths: [],
    notes: 'Timing-dependent.',
    alternativeVerification: 'Reviewed the scheduler path.',
  })

  it('prefers the harness verdict when one came back', () => {
    const s = step({})
    const run = { steps: [conceded, s], currentStep: 1 }
    recordReproductionOutcome(
      s,
      { status: 'reproduced', command: 'c', testPaths: [], attempts: 1, maxAttempts: 3, at: 1 },
      run,
      99,
    )
    // The concede is older news — a proof actually ran, so it is what the reviewer must see.
    expect(s.reproduction?.status).toBe('reproduced')
  })

  it('mints the structural declaration when a concede dispatched no proof', () => {
    const s = step({})
    recordReproductionOutcome(s, undefined, { steps: [conceded, s], currentStep: 1 }, 99)
    expect(s.reproduction).toMatchObject({
      status: 'declared_infeasible',
      reason: 'Timing-dependent.',
      alternativeVerification: 'Reviewed the scheduler path.',
      at: 99,
    })
  })

  it('does not fold a concede onto a step other than the PR-opening producer', () => {
    // Otherwise every step after the reproduction step would show the same infeasibility card.
    const s = step({ agentKind: 'reviewer' })
    recordReproductionOutcome(s, undefined, { steps: [conceded, s], currentStep: 1 }, 99)
    expect(s.reproduction).toBeUndefined()
  })

  it('records nothing for a run with no reproduction step at all', () => {
    const s = step({})
    recordReproductionOutcome(s, undefined, { steps: [step({}), s], currentStep: 1 }, 99)
    expect(s.reproduction).toBeUndefined()
  })
})
