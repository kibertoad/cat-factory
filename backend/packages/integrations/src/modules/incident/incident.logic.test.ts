import { describe, expect, it } from 'vitest'
import { type IncidentCandidate, pickIncidentToEnrich } from './incident.logic.js'

const c = (id: string, text: string, createdAtMs: number): IncidentCandidate<string> => ({
  raw: id,
  text,
  createdAtMs,
})

describe('pickIncidentToEnrich', () => {
  it('returns null when there are no candidates', () => {
    expect(pickIncidentToEnrich([], ['123'])).toBeNull()
  })

  it('prefers an incident whose text references a regressed signal id', () => {
    const candidates = [
      c('newer-unrelated', 'Checkout latency spike', 3),
      c('older-match', 'Monitor 123 alerting on error rate', 1),
    ]
    // The signal-referencing incident wins even though it is older.
    expect(pickIncidentToEnrich(candidates, ['123'])).toBe('older-match')
  })

  it('falls back to the most recent incident when none reference a signal', () => {
    const candidates = [
      c('older', 'unrelated A', 1),
      c('newer', 'unrelated B', 5),
    ]
    expect(pickIncidentToEnrich(candidates, ['123'])).toBe('newer')
  })

  it('falls back to recency when no signal ids are supplied', () => {
    const candidates = [c('older', 'x', 1), c('newer', 'y', 2)]
    expect(pickIncidentToEnrich(candidates, [])).toBe('newer')
  })

  it('picks the most recent among several signal-referencing incidents', () => {
    const candidates = [
      c('old-match', 'slo 999 breached', 1),
      c('new-match', 'slo 999 still breached', 9),
    ]
    expect(pickIncidentToEnrich(candidates, ['999'])).toBe('new-match')
  })

  it('ignores empty signal ids', () => {
    const candidates = [c('a', 'whatever', 1), c('b', '', 2)]
    // An empty id must not match every incident via `''.includes`.
    expect(pickIncidentToEnrich(candidates, [''])).toBe('b')
  })
})
