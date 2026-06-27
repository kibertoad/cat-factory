import { afterEach, describe, expect, it } from 'vitest'
import { clearRegisteredAgentKinds, registerAgentKind } from './registry.js'
import { agentTuningFor } from './tuning.js'

// Per-kind execution tuning resolution: a registered custom kind's own `tuning` wins,
// then the built-in table, then undefined (the harness keeps its defaults).

describe('agentTuningFor', () => {
  afterEach(() => clearRegisteredAgentKinds())

  it('returns the built-in tuning for a kind that has one', () => {
    // conflict-resolver loosens the consecutive-error budget.
    expect(agentTuningFor('conflict-resolver')).toEqual({
      guardLimits: { maxConsecutiveErrors: 20 },
    })
    // researcher loosens the consecutive-web cap (web is its primary tool).
    expect(agentTuningFor('researcher')?.guardLimits?.maxConsecutiveWebCalls).toBeGreaterThan(25)
  })

  it('returns undefined for an un-tuned kind (harness keeps its defaults)', () => {
    expect(agentTuningFor('coder')).toBeUndefined()
  })

  it("lets a registered custom kind's own tuning win", () => {
    registerAgentKind({
      kind: 'org-auditor',
      systemPrompt: 'x',
      tuning: { guardLimits: { maxConsecutiveWebCalls: 99 } },
    })
    expect(agentTuningFor('org-auditor')).toEqual({
      guardLimits: { maxConsecutiveWebCalls: 99 },
    })
  })
})
