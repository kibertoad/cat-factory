import { describe, expect, it } from 'vitest'
import { inferTechnicalLabel } from './technical.logic.js'

describe('inferTechnicalLabel', () => {
  it('infers technical=true when the writer produced no business specs AND the companion corroborates', () => {
    expect(inferTechnicalLabel(undefined, true, true)).toBe(true)
    expect(inferTechnicalLabel(null, true, true)).toBe(true)
  })

  it('infers the symmetric business case (false) when specs were produced', () => {
    expect(inferTechnicalLabel(undefined, false, false)).toBe(false)
    // The writer's "specs produced" signal wins even if the companion's flag disagrees.
    expect(inferTechnicalLabel(undefined, false, true)).toBe(false)
  })

  it('does not infer technical when the companion disputes the "no specs" claim', () => {
    // noBusinessSpecs but the companion did not corroborate ⇒ not technical.
    expect(inferTechnicalLabel(undefined, true, false)).toBe(false)
  })

  it('makes no change when the companion gave no opinion (technicalCorroborated undefined)', () => {
    expect(inferTechnicalLabel(undefined, true, undefined)).toBeUndefined()
    expect(inferTechnicalLabel(null, false, undefined)).toBeUndefined()
  })

  it('never overrides a human-set (concrete) label', () => {
    // A human (or a prior inference) set it true/false — authoritative, never re-decided.
    expect(inferTechnicalLabel(true, false, false)).toBeUndefined()
    expect(inferTechnicalLabel(false, true, true)).toBeUndefined()
    expect(inferTechnicalLabel(true, true, true)).toBeUndefined()
  })
})
