import { describe, expect, it } from 'vitest'
import type { PipelineStep, RunnerReproductionReport } from '@cat-factory/kernel'
import type { ReproductionReport } from '@cat-factory/contracts'
import { REPRODUCTION_MAX_COMMAND_CHARS, REPRODUCTION_MAX_TEST_PATHS } from '@cat-factory/contracts'
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

// The kernel's `RunnerReproductionReport` mirrors the contracts schema BY HAND (kernel carries no
// valibot dependency), so nothing but this assignment stops the two drifting apart on a rename.
// Only this direction is asserted: a PARSED report must always be publishable as the wire shape,
// whose `at` is optional because an older harness image may omit it.
const _mirrorsTheWireShape = (report: ReproductionReport): RunnerReproductionReport => report

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

  // `reproTestOutcome` falls back to `not_reproducible` for an unreadable reply — fine as a hint
  // to the coder, fatal here, because this feature PUBLISHES that value as the agent's own
  // structural declaration. A reply that never named an outcome must read as "no declaration".
  it.each([[{}], [{ testPaths: [], notes: 'hi' }], [{ outcome: 'nonsense' }], [null], ['text']])(
    'ignores a reproduction step whose reply declared no outcome (%o)',
    (custom) => {
      expect(reproductionDeclarationFrom([reproStep(custom), step({})], 2)).toBeUndefined()
    },
  )

  it('falls back to an EARLIER step that did declare one', () => {
    const steps = [reproStep(fullDeclaration), reproStep({}), step({})]
    expect(reproductionDeclarationFrom(steps, 2)?.command).toBe('pnpm vitest run a.test.ts')
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

  it('does not invent a spec for `always` when the run declared nothing', () => {
    // `always` is not "run something regardless" — fabricating a command would produce a verdict
    // about a test that does not exist.
    expect(
      resolveReproductionSpec({
        ...base,
        agentKind: 'coder',
        agentConfig: { 'coder.reproductionProof': 'always' },
        steps: [step({})],
      }),
    ).toBeUndefined()
  })

  // The declared strings are MODEL-AUTHORED and reach `sh -c` / a worktree write, so the
  // resolution boundary is where they are bounded.
  describe('bounds the declared command and paths', () => {
    it('declines the spec for an over-long command or setup command', () => {
      const long = 'x'.repeat(REPRODUCTION_MAX_COMMAND_CHARS + 1)
      expect(
        resolveReproductionSpec({
          ...base,
          agentKind: 'coder',
          steps: [reproStep({ ...fullDeclaration, command: long })],
        }),
      ).toBeUndefined()
      // An over-long SETUP command declines the whole spec too: running the final tree with a
      // setup the base tree never got is exactly how a false `reproduced` is manufactured.
      expect(
        resolveReproductionSpec({
          ...base,
          agentKind: 'coder',
          steps: [reproStep({ ...fullDeclaration, setupCommand: long })],
        }),
      ).toBeUndefined()
    })

    it('drops absolute, traversing and over-long paths, and COUNTS what it dropped', () => {
      const spec = resolveReproductionSpec({
        ...base,
        agentKind: 'coder',
        steps: [
          reproStep({
            ...fullDeclaration,
            testPaths: [
              'src/a.test.ts',
              '/etc/passwd',
              '../../outside.test.ts',
              'src/../b.test.ts',
              '~/secrets',
              'C:/windows/system32',
              'x'.repeat(500),
              '',
            ],
          }),
        ],
      })
      // Only the repo-relative, traversal-free path survives. The six rejects are COUNTED so the
      // proof can say the pre-fix tree was rebuilt from an incomplete reproduction; the empty
      // string is not a rejection, just noise, so it isn't counted.
      expect(spec?.testPaths).toEqual(['src/a.test.ts'])
      expect(spec?.omittedTestPaths).toBe(6)
    })

    it('caps the list and counts the overflow rather than truncating silently', () => {
      const spec = resolveReproductionSpec({
        ...base,
        agentKind: 'coder',
        steps: [
          reproStep({
            ...fullDeclaration,
            testPaths: Array.from(
              { length: REPRODUCTION_MAX_TEST_PATHS + 3 },
              (_, i) => `t${i}.ts`,
            ),
          }),
        ],
      })
      expect(spec?.testPaths).toHaveLength(REPRODUCTION_MAX_TEST_PATHS)
      expect(spec?.omittedTestPaths).toBe(3)
    })

    it('omits the counter entirely when nothing was dropped', () => {
      const spec = resolveReproductionSpec({
        ...base,
        agentKind: 'coder',
        steps: [reproStep(fullDeclaration)],
      })
      expect(spec).not.toHaveProperty('omittedTestPaths')
    })
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

  it('mints NOTHING for a malformed reply the schema would default to not_reproducible', () => {
    // The dangerous case: `{}` parses cleanly (every field has a fallback) and would otherwise be
    // published as "the agent declared this bug non-reproducible" — a claim it never made.
    expect(concededReproductionReport([reproStep({})], 1, 0)).toBeUndefined()
  })

  it('says so when a real concede named neither a reason nor an alternative', () => {
    // A blank infeasibility card is indistinguishable from a rendering bug — and from a run that
    // never tried, which is the whole thing this feature closes.
    const report = concededReproductionReport(
      [reproStep({ outcome: 'not_reproducible', testPaths: [] })],
      1,
      7,
    )
    expect(report?.status).toBe('declared_infeasible')
    expect(report?.note).toContain('no reason')
    expect(report?.reason).toBeUndefined()
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

  it('keeps the harness verdict a live poll already applied, without falling through', () => {
    // The terminal result re-offers the same report, so `applyReproductionReport` reports no
    // change — the concede branch must not then overwrite a real proof with older news.
    const s = step({})
    const harness = {
      status: 'reproduced' as const,
      command: 'c',
      testPaths: [],
      attempts: 1,
      maxAttempts: 3,
      at: 5,
    }
    const run = { steps: [conceded, s], currentStep: 1 }
    recordReproductionOutcome(s, harness, run, 99)
    recordReproductionOutcome(s, { ...harness }, run, 100)
    expect(s.reproduction?.status).toBe('reproduced')
  })
})
