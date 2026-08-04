import { describe, expect, it } from 'vitest'
import { agentFailureKindSchema, isAgentFailureKind } from './agent-failure-kinds.js'

// The predicate is the SHARED answer to "does this build produce that failure kind" — asked by
// the SPA about a stored alert rule and by the env parser about an operator-typed one. These pin
// that it stays derived from the picklist (so it cannot drift from it) and that a retired or
// mistyped kind reads as a non-member rather than being guessed onto a current one.

describe('isAgentFailureKind', () => {
  it('accepts every member of the picklist', () => {
    for (const kind of agentFailureKindSchema.options) {
      expect(isAgentFailureKind(kind)).toBe(true)
    }
  })

  it('rejects a retired or mistyped kind rather than guessing a current one', () => {
    // A plausible typo of a real member, which is the case that matters: the rule parses, is
    // stored, and can never fire, so something has to be able to say so.
    expect(isAgentFailureKind('evicetd')).toBe(false)
    // A kind that could plausibly have existed and been retired.
    expect(isAgentFailureKind('container')).toBe(false)
    expect(isAgentFailureKind('')).toBe(false)
    expect(isAgentFailureKind('EVICTED')).toBe(false)
  })

  it('does not answer for inherited object properties', () => {
    // Backed by a Set, not an object lookup: `'constructor' in {}` is true and would make a
    // rule named after a prototype member read as a live failure kind.
    expect(isAgentFailureKind('constructor')).toBe(false)
    expect(isAgentFailureKind('toString')).toBe(false)
  })
})
