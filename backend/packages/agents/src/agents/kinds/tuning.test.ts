import { describe, expect, it } from 'vitest'
import { AgentKindRegistry } from './registry.js'
import { agentTuningFor } from './tuning.js'

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
