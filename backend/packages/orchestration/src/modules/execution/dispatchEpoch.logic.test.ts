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
