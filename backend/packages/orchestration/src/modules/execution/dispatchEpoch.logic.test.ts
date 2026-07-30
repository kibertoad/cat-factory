import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '@cat-factory/kernel'
import { dispatchEpochFor } from './AgentContextBuilder.js'

// A re-dispatched step must get a FRESH harness job id each round so it never re-attaches to a
// prior round's completed job on a container-reusing transport (a warm local pool / self-hosted
// runner pool). The per-round epoch is derived here; both looping shapes (the Tester→Fixer loop
// and a polling gate's helper loop) carry their round count on their own state. This pins the
// derivation for BOTH — the gate path is otherwise only exercised indirectly.
const step = (over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind: 'tester-api', state: 'running', ...over }) as PipelineStep

describe('dispatchEpochFor', () => {
  it('is 0 for a step dispatched once (no loop state) so the job id stays unsuffixed', () => {
    expect(dispatchEpochFor(step())).toBe(0)
  })

  it('tracks the Tester→Fixer loop on step.test.attempts (a fixer round per increment)', () => {
    expect(
      dispatchEpochFor(step({ test: { phase: 'testing', attempts: 0, maxAttempts: 10 } })),
    ).toBe(0)
    expect(
      dispatchEpochFor(step({ test: { phase: 'testing', attempts: 1, maxAttempts: 10 } })),
    ).toBe(1)
    expect(
      dispatchEpochFor(step({ test: { phase: 'fixing', attempts: 3, maxAttempts: 10 } })),
    ).toBe(3)
  })

  it('tracks a polling gate helper loop on step.gate.attempts (the CI/conflicts fixer shape)', () => {
    expect(
      dispatchEpochFor(
        step({ agentKind: 'ci', gate: { phase: 'checking', attempts: 0, maxAttempts: 10 } }),
      ),
    ).toBe(0)
    expect(
      dispatchEpochFor(
        step({ agentKind: 'ci', gate: { phase: 'working', attempts: 2, maxAttempts: 10 } }),
      ),
    ).toBe(2)
  })

  it('counts an eviction recovery, so the retry never re-uses the dead job id', () => {
    // A pool is told to keep routing sticky by job id, so reusing it after an eviction routes
    // the recovery straight back to the job whose runner just died instead of onto a fresh
    // member — making the eviction budget a no-op exactly where it was added to help.
    expect(dispatchEpochFor(step({ evictionRecoveries: 1 }))).toBe(1)
    expect(dispatchEpochFor(step({ transientEvictionRecoveries: 3 }))).toBe(3)
    expect(dispatchEpochFor(step({ evictionRecoveries: 1, transientEvictionRecoveries: 2 }))).toBe(
      3,
    )
  })

  it('sums the loop round and the eviction recoveries so two rounds can never collide', () => {
    // Both components only ever increase, so every re-dispatch after any increment mints a
    // strictly larger epoch. A tester round that lost a container must not land on the id its
    // own previous round already completed under.
    const evictedFirstRound = step({
      test: { phase: 'testing', attempts: 0, maxAttempts: 10 },
      evictionRecoveries: 1,
    })
    const secondRound = step({ test: { phase: 'fixing', attempts: 1, maxAttempts: 10 } })
    expect(dispatchEpochFor(evictedFirstRound)).toBe(1)
    expect(dispatchEpochFor({ ...secondRound, evictionRecoveries: 1 } as PipelineStep)).toBe(2)
  })

  it('counts a manually resumed PR review, which carries none of the loop counters above', () => {
    // The whole premise of a resume is that the previous job is WEDGED. A container-reusing
    // transport re-attaches to a known job id rather than re-running, so a resume at the same
    // epoch would hand the "recovery" straight back to the stuck job. The reviewer step has no
    // test/gate/ralph counter, so without this term its epoch would stay 0 across every resume.
    const review = (resumeAttempts: number): PipelineStep =>
      step({
        agentKind: 'pr-reviewer',
        prReview: { status: 'reviewing', resumeAttempts } as PipelineStep['prReview'],
      })
    expect(dispatchEpochFor(review(0))).toBe(0)
    expect(dispatchEpochFor(review(1))).toBe(1)
    expect(dispatchEpochFor(review(2))).toBe(2)
  })

  it('prefers the tester counter when both are present, and treats attempts 0 as 0 (not a fallthrough)', () => {
    // `??` must not fall through on a real 0 — a first-round tester step is epoch 0, never the gate count.
    expect(
      dispatchEpochFor(
        step({
          test: { phase: 'testing', attempts: 0, maxAttempts: 10 },
          gate: { phase: 'working', attempts: 5, maxAttempts: 10 },
        }),
      ),
    ).toBe(0)
  })
})
