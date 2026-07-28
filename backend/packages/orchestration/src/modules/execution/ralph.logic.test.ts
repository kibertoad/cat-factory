import { describe, it, expect } from 'vitest'
import type { RalphStepState } from '@cat-factory/kernel'
import {
  appendRalphAttempt,
  buildRalphValidation,
  decideRalphNext,
  isRalphKind,
  lastRecordedHeadSha,
  MAX_RALPH_ATTEMPT_LOG,
  MAX_RALPH_ITERATIONS_CAP,
  nextNoProgressStreak,
  RALPH_NO_PROGRESS_LIMIT,
  RALPH_PROGRESS_PATH,
  resolveRalphConfig,
  restartRalphState,
  seedRalphState,
} from './ralph.logic.js'
import { RALPH_AGENT_KIND } from '@cat-factory/agents'

const state = (over: Partial<RalphStepState> = {}): RalphStepState => ({
  phase: 'iterating',
  attempts: 0,
  maxIterations: 5,
  validationCommand: 'pnpm test',
  progressPath: RALPH_PROGRESS_PATH,
  attemptLog: [],
  ...over,
})

describe('ralph.logic', () => {
  it('identifies the ralph kind', () => {
    expect(isRalphKind(RALPH_AGENT_KIND)).toBe(true)
    expect(isRalphKind('coder')).toBe(false)
  })

  describe('resolveRalphConfig', () => {
    it('reads the command + iteration budget from agent config', () => {
      const cfg = resolveRalphConfig({
        'ralph.validationCommand': '  pnpm test && pnpm typecheck  ',
        'ralph.maxIterations': '8',
      })
      expect(cfg.validationCommand).toBe('pnpm test && pnpm typecheck')
      expect(cfg.maxIterations).toBe(8)
    })

    it('defaults the budget and leaves the command empty when unset', () => {
      const cfg = resolveRalphConfig(undefined)
      expect(cfg.validationCommand).toBe('')
      expect(cfg.maxIterations).toBe(10)
    })

    it('clamps a non-positive or over-cap budget', () => {
      expect(resolveRalphConfig({ 'ralph.maxIterations': '0' }).maxIterations).toBe(10)
      expect(resolveRalphConfig({ 'ralph.maxIterations': 'nope' }).maxIterations).toBe(10)
      expect(resolveRalphConfig({ 'ralph.maxIterations': '9999' }).maxIterations).toBe(
        MAX_RALPH_ITERATIONS_CAP,
      )
    })
  })

  it('seeds a fresh loop state at zero attempts', () => {
    const seeded = seedRalphState({ validationCommand: 'make check', maxIterations: 4 })
    expect(seeded).toMatchObject({
      phase: 'iterating',
      attempts: 0,
      maxIterations: 4,
      validationCommand: 'make check',
      progressPath: RALPH_PROGRESS_PATH,
      attemptLog: [],
    })
  })

  describe('buildRalphValidation', () => {
    it('folds the command + the next iteration number (attempts + 1)', () => {
      expect(buildRalphValidation(state({ attempts: 0 }))).toEqual({
        command: 'pnpm test',
        progressPath: RALPH_PROGRESS_PATH,
        iteration: 1,
      })
      expect(buildRalphValidation(state({ attempts: 2 }))?.iteration).toBe(3)
    })

    it('returns undefined when there is no state or no command', () => {
      expect(buildRalphValidation(null)).toBeUndefined()
      expect(buildRalphValidation(state({ validationCommand: '' }))).toBeUndefined()
      expect(buildRalphValidation(state({ validationCommand: '   ' }))).toBeUndefined()
    })
  })

  describe('decideRalphNext', () => {
    it('is done when the validation passed', () => {
      expect(decideRalphNext(state({ attempts: 1 }), { validationPassed: true, exitCode: 0 })).toBe(
        'done',
      )
    })

    it('retries a failing verdict while the budget remains', () => {
      expect(
        decideRalphNext(state({ attempts: 1, maxIterations: 3 }), {
          validationPassed: false,
          exitCode: 1,
        }),
      ).toBe('retry')
    })

    it('exhausts once the budget is spent', () => {
      expect(
        decideRalphNext(state({ attempts: 3, maxIterations: 3 }), {
          validationPassed: false,
          exitCode: 1,
        }),
      ).toBe('exhausted')
    })

    it('exhausts on a missing verdict at the budget, retries below it', () => {
      expect(decideRalphNext(state({ attempts: 3, maxIterations: 3 }), null)).toBe('exhausted')
      expect(decideRalphNext(state({ attempts: 1, maxIterations: 3 }), null)).toBe('retry')
    })

    it('stalls at the no-progress limit even with budget left', () => {
      expect(
        decideRalphNext(
          state({ attempts: 2, maxIterations: 20, noProgressStreak: RALPH_NO_PROGRESS_LIMIT }),
          { validationPassed: false, exitCode: 1 },
        ),
      ).toBe('stalled')
    })

    it('never stalls a PASSING verdict, however long the branch sat still', () => {
      expect(
        decideRalphNext(state({ attempts: 4, noProgressStreak: 9 }), {
          validationPassed: true,
          exitCode: 0,
        }),
      ).toBe('done')
    })
  })

  describe('nextNoProgressStreak', () => {
    const failed = (headSha?: string) => ({
      validationPassed: false,
      exitCode: 1,
      headSha,
    })

    it('extends the streak when the head did not move', () => {
      expect(nextNoProgressStreak(state({ noProgressStreak: 1 }), failed('abc'), 'abc')).toBe(2)
    })

    it('resets when the head moved', () => {
      expect(nextNoProgressStreak(state({ noProgressStreak: 3 }), failed('def'), 'abc')).toBe(0)
    })

    it('resets on a pass', () => {
      expect(
        nextNoProgressStreak(
          state({ noProgressStreak: 3 }),
          { validationPassed: true, exitCode: 0, headSha: 'abc' },
          'abc',
        ),
      ).toBe(0)
    })

    it('FAILS OPEN on an unknown head (an older harness image never trips the guard)', () => {
      expect(nextNoProgressStreak(state({ noProgressStreak: 1 }), failed(undefined), 'abc')).toBe(0)
      expect(nextNoProgressStreak(state({ noProgressStreak: 1 }), failed('   '), 'abc')).toBe(0)
      // No previous head recorded either (the first iteration of a loop).
      expect(nextNoProgressStreak(state({ noProgressStreak: 1 }), failed('abc'), null)).toBe(0)
    })

    it('reads the previous head off the last recorded attempt', () => {
      expect(lastRecordedHeadSha(state())).toBeNull()
      expect(
        lastRecordedHeadSha(
          state({
            attemptLog: [
              { attempt: 1, at: 1, validationPassed: false, headSha: 'old' },
              { attempt: 2, at: 2, validationPassed: false, headSha: 'new' },
            ],
          }),
        ),
      ).toBe('new')
    })
  })

  describe('appendRalphAttempt', () => {
    const entry = (attempt: number) => ({ attempt, at: attempt, validationPassed: false })

    it('appends within the cap without dropping anything', () => {
      const { attemptLog, droppedAttempts } = appendRalphAttempt(
        state({ attemptLog: [entry(1)] }),
        entry(2),
      )
      expect(attemptLog.map((a) => a.attempt)).toEqual([1, 2])
      expect(droppedAttempts).toBe(0)
    })

    it('keeps the newest entries at the cap and COUNTS what it dropped', () => {
      const full = state({
        attemptLog: Array.from({ length: MAX_RALPH_ATTEMPT_LOG }, (_, i) => entry(i + 1)),
      })
      const { attemptLog, droppedAttempts } = appendRalphAttempt(full, entry(99))
      expect(attemptLog).toHaveLength(MAX_RALPH_ATTEMPT_LOG)
      expect(attemptLog.at(0)?.attempt).toBe(2)
      expect(attemptLog.at(-1)?.attempt).toBe(99)
      expect(droppedAttempts).toBe(1)
    })

    it('accumulates the dropped count across appends', () => {
      const full = state({
        attemptLog: Array.from({ length: MAX_RALPH_ATTEMPT_LOG }, (_, i) => entry(i + 1)),
        droppedAttempts: 4,
      })
      expect(appendRalphAttempt(full, entry(99)).droppedAttempts).toBe(5)
    })
  })

  describe('restartRalphState', () => {
    it('keeps the frozen config and zeroes the counters', () => {
      const spent = state({
        attempts: 7,
        maxIterations: 7,
        validationCommand: 'make check',
        noProgressStreak: 2,
        droppedAttempts: 3,
        lastExitCode: 1,
        lastValidationTail: 'boom',
        attemptLog: [{ attempt: 7, at: 1, validationPassed: false }],
      })
      expect(restartRalphState(spent)).toEqual({
        phase: 'iterating',
        attempts: 0,
        maxIterations: 7,
        validationCommand: 'make check',
        progressPath: RALPH_PROGRESS_PATH,
        attemptLog: [],
      })
    })

    it('is undefined for a step that carries no loop state', () => {
      expect(restartRalphState(undefined)).toBeUndefined()
      expect(restartRalphState(null)).toBeUndefined()
    })
  })
})
