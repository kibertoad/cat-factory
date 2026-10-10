import { describe, expect, it } from 'vitest'
import { AgentKindRegistry } from './registry.js'
import { agentTuningFor, withComplexityAllowance } from './tuning.js'

// Per-kind execution tuning resolution: a registered custom kind's own `tuning` wins,
// then the built-in table, then undefined (the harness keeps its defaults).

describe('agentTuningFor', () => {
  it('returns the built-in tuning for a kind that has one', () => {
    const registry = new AgentKindRegistry()
    // conflict-resolver loosens the consecutive-error budget.
    expect(agentTuningFor('conflict-resolver', registry)).toEqual({
      guardLimits: { maxConsecutiveErrors: 20 },
    })
    // researcher loosens the consecutive-web cap (web is its primary tool).
    expect(
      agentTuningFor('researcher', registry)?.guardLimits?.maxConsecutiveWebCalls,
    ).toBeGreaterThan(25)
  })

  it('returns undefined for an un-tuned kind (harness keeps its defaults)', () => {
    const registry = new AgentKindRegistry()
    expect(agentTuningFor('coder', registry)).toBeUndefined()
  })

  it("lets a registered custom kind's own tuning win", () => {
    const registry = new AgentKindRegistry()
    registry.register({
      kind: 'org-auditor',
      systemPrompt: 'x',
      tuning: { guardLimits: { maxConsecutiveWebCalls: 99 } },
    })
    expect(agentTuningFor('org-auditor', registry)).toEqual({
      guardLimits: { maxConsecutiveWebCalls: 99 },
    })
  })
})

// The task-estimator's complexity extends the no-edit exploration allowance (loosen-only), so a
// complex task earns more probing before its first edit; no estimate ⇒ the conservative default.
describe('withComplexityAllowance', () => {
  it('leaves tuning untouched when there is no estimate', () => {
    expect(withComplexityAllowance(undefined, undefined)).toBeUndefined()
    expect(withComplexityAllowance({ maxConsecutiveErrors: 20 }, undefined)).toEqual({
      maxConsecutiveErrors: 20,
    })
  })

  it('scales the no-edit allowance with complexity (higher complexity ⇒ larger allowance)', () => {
    const trivial = withComplexityAllowance(undefined, 0)?.maxToolCallsWithoutEdit
    const complex = withComplexityAllowance(undefined, 1)?.maxToolCallsWithoutEdit
    expect(trivial).toBe(40) // mirrors the harness default at complexity 0
    expect(complex).toBeGreaterThan(trivial as number)
  })

  it('only ever RAISES the allowance — never below a per-kind tuning value, and clamps input', () => {
    // A high per-kind bound is preserved even for a low-complexity task (max, not overwrite).
    expect(
      withComplexityAllowance({ maxToolCallsWithoutEdit: 200 }, 0.1)?.maxToolCallsWithoutEdit,
    ).toBe(200)
    // Out-of-range complexity is clamped to [0,1] rather than producing a wild allowance.
    expect(withComplexityAllowance(undefined, 5)?.maxToolCallsWithoutEdit).toBe(
      withComplexityAllowance(undefined, 1)?.maxToolCallsWithoutEdit,
    )
    // Preserves the other (risk-orthogonal) knobs.
    expect(withComplexityAllowance({ maxConsecutiveErrors: 20 }, 0.5)).toMatchObject({
      maxConsecutiveErrors: 20,
    })
  })
})
