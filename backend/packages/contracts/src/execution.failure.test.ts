import { describe, expect, it } from 'vitest'
import type { AgentFailure } from './execution.js'
import { isUsableAgentFailure, parseStoredAgentFailure } from './execution.js'

// The lenient decode of the `agent_runs.failure` column, shared by every run kind's
// repositories on both runtimes. The bar it enforces is the FULL wire schema, because the
// SPA re-validates the whole workspace snapshot: a record that satisfies a weaker check
// (the `typeof kind === 'string'` parsers these replaced) but not the schema would brick
// the entire board load rather than degrade one card.

/** A structurally complete failure — every non-optional field of the schema present. */
function complete(overrides: Partial<AgentFailure> = {}): AgentFailure {
  return {
    kind: 'agent',
    message: 'boom',
    detail: null,
    hint: null,
    occurredAt: 1,
    lastSubtasks: null,
    ...overrides,
  } as AgentFailure
}

describe('parseStoredAgentFailure', () => {
  it('reads a complete record back unchanged', () => {
    const failure = complete({ detail: 'stderr tail', hint: 'check the logs', stepIndex: 2 })
    expect(parseStoredAgentFailure(JSON.stringify(failure))).toEqual(failure)
  })

  it('treats an absent, empty and unparseable column identically (no record)', () => {
    expect(parseStoredAgentFailure(null)).toBeNull()
    expect(parseStoredAgentFailure(undefined)).toBeNull()
    expect(parseStoredAgentFailure('')).toBeNull()
    expect(parseStoredAgentFailure('{not json')).toBeNull()
    expect(parseStoredAgentFailure('null')).toBeNull()
  })

  it('drops a kind outside the picklist even when the record is otherwise complete', () => {
    // The case the retired `isKnownAgentFailureKind` shim existed for: a kind persisted
    // before it left the contract (e.g. the removed `decision_timeout`). Full-schema
    // validation subsumes that check — the picklist no longer lists it.
    expect(
      parseStoredAgentFailure(JSON.stringify(complete({ kind: 'no_such_kind' } as never))),
    ).toBeNull()
  })

  it('drops a known kind whose record is structurally incomplete', () => {
    // Each of these passed the weaker `kind`/`message` check the four repositories used to
    // hand-roll, and each would fail the SPA's snapshot decode.
    const { detail: _d, ...noDetail } = complete()
    const { hint: _h, ...noHint } = complete()
    const { occurredAt: _o, ...noOccurredAt } = complete()
    const { lastSubtasks: _l, ...noLastSubtasks } = complete()
    for (const partial of [noDetail, noHint, noOccurredAt, noLastSubtasks, { kind: 'agent' }]) {
      expect(parseStoredAgentFailure(JSON.stringify(partial))).toBeNull()
    }
  })

  it('drops a non-object payload', () => {
    for (const raw of ['[]', '"boom"', '42']) {
      expect(parseStoredAgentFailure(raw)).toBeNull()
    }
  })
})

describe('isUsableAgentFailure', () => {
  it('accepts a complete record and rejects a partial one', () => {
    expect(isUsableAgentFailure(complete())).toBe(true)
    expect(isUsableAgentFailure({ kind: 'agent', message: 'boom' })).toBe(false)
    expect(isUsableAgentFailure(undefined)).toBe(false)
  })
})
