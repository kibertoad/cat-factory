import { describe, it, expect } from 'vitest'
import type { RalphStepState } from '@cat-factory/kernel'
import {
  buildRalphValidation,
  decideRalphNext,
  isRalphKind,
  MAX_RALPH_ITERATIONS_CAP,
  RALPH_PROGRESS_PATH,
  resolveRalphConfig,
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
  })
})
