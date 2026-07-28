import { describe, expect, it } from 'vitest'
import { normalizeCallPhase, UNATTRIBUTED_CALL_PHASE } from './llm-phase.js'

describe('normalizeCallPhase', () => {
  it('keeps a phase label as the store and the rollup will key on it', () => {
    expect(normalizeCallPhase('validation-repair')).toBe('validation-repair')
    // Case and padding are normalised rather than preserved: a `GROUP BY phase` must not split
    // one phase into three because two producers spelled it differently.
    expect(normalizeCallPhase(' Agent ')).toBe('agent')
  })

  it('refuses anything that is not a phase label', () => {
    // Two of the three producing paths are inputs the platform does not author — a proxy
    // request path and a runner pool's JSON — so this is a boundary, not a formality.
    expect(normalizeCallPhase('repair round')).toBe(UNATTRIBUTED_CALL_PHASE)
    expect(normalizeCallPhase('../../etc')).toBe(UNATTRIBUTED_CALL_PHASE)
    expect(normalizeCallPhase('x'.repeat(33))).toBe(UNATTRIBUTED_CALL_PHASE)
    expect(normalizeCallPhase(undefined)).toBe(UNATTRIBUTED_CALL_PHASE)
    expect(normalizeCallPhase(7)).toBe(UNATTRIBUTED_CALL_PHASE)
  })

  it('passes through a phase this build has never heard of', () => {
    // The harness's marker is free-form: a new phase must reach telemetry verbatim rather than
    // be coerced into the unattributed slice by a backend that predates it.
    expect(normalizeCallPhase('compaction')).toBe('compaction')
  })
})
