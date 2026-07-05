import { describe, expect, it } from 'vitest'
import { recordGateAttempt } from './gate-registry.js'
import type { GateStepState } from './types.js'

const gate = (over: Partial<GateStepState> = {}): GateStepState => ({
  phase: 'checking',
  attempts: 2,
  maxAttempts: 3,
  headSha: 'abc1234',
  ...over,
})

describe('recordGateAttempt', () => {
  it('records a completed helper run with the helper output as the summary', () => {
    const attempt = recordGateAttempt(
      gate(),
      { state: 'done', output: 'Could not fully resolve (2 file(s) still conflicted: a, b).' },
      1_000,
    )
    expect(attempt).toEqual({
      attempt: 2,
      at: 1_000,
      outcome: 'completed',
      headSha: 'abc1234',
      summary: 'Could not fully resolve (2 file(s) still conflicted: a, b).',
    })
  })

  it('records a failed helper run with the error as the summary', () => {
    const attempt = recordGateAttempt(
      gate(),
      { state: 'failed', error: 'Container evicted' },
      2_000,
    )
    expect(attempt.outcome).toBe('failed')
    expect(attempt.summary).toBe('Container evicted')
    expect(attempt.attempt).toBe(2)
  })

  it('falls back to a generic message when a failed job has no error text', () => {
    const attempt = recordGateAttempt(gate(), { state: 'failed', error: null }, 3_000)
    expect(attempt.summary).toBe('The helper agent failed without finishing.')
  })

  it('carries a null summary when a completed job produced no output', () => {
    const attempt = recordGateAttempt(gate(), { state: 'done', output: null }, 4_000)
    expect(attempt.outcome).toBe('completed')
    expect(attempt.summary).toBeNull()
  })

  it('stamps the current attempt number and gated head sha onto the record', () => {
    const attempt = recordGateAttempt(
      gate({ attempts: 1, headSha: null }),
      { state: 'done', output: 'pushed a fix' },
      5_000,
    )
    expect(attempt.attempt).toBe(1)
    expect(attempt.headSha).toBeNull()
  })

  it('captures the fixing instructions handed to the helper this round', () => {
    const attempt = recordGateAttempt(
      gate({ lastDispatchedInstructions: '2 check(s) failing: build, lint.' }),
      { state: 'done', output: 'pushed a fix' },
      6_000,
    )
    expect(attempt.instructions).toBe('2 check(s) failing: build, lint.')
  })

  it('captures the structured failing checks handed to a CI-gate helper round', () => {
    const failingChecks = [{ name: 'build', conclusion: 'failure', url: null }]
    const attempt = recordGateAttempt(
      gate({ lastDispatchedInstructions: '1 check failing: build.', failingChecks }),
      { state: 'done', output: null },
      7_000,
    )
    expect(attempt.failingChecks).toEqual(failingChecks)
    expect(attempt.instructions).toBe('1 check failing: build.')
  })

  it('omits instructions / failingChecks when the gate handed the helper none (conflicts gate)', () => {
    const attempt = recordGateAttempt(gate(), { state: 'done', output: 'resolved' }, 8_000)
    expect(attempt).not.toHaveProperty('instructions')
    expect(attempt).not.toHaveProperty('failingChecks')
  })
})
