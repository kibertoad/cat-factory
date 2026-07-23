import { describe, it, expect } from 'vitest'
import { effortBand, effortHint } from './effort'

describe('effortBand', () => {
  it('bands the 1..10 self-rating at the shared thresholds', () => {
    expect(effortBand(1)).toBe('easy')
    expect(effortBand(4)).toBe('easy')
    expect(effortBand(5)).toBe('moderate')
    expect(effortBand(7)).toBe('moderate')
    expect(effortBand(8)).toBe('hard')
    expect(effortBand(10)).toBe('hard')
  })
})

describe('effortHint', () => {
  it('prefers what held the agent back over the work summary', () => {
    expect(
      effortHint({
        difficulty: 7,
        summary: 'Refactored the parser.',
        reducedEffectiveness: 'Flaky test tooling.',
      }),
    ).toBe('Flaky test tooling.')
  })

  it('falls back to the summary, then to nothing', () => {
    expect(effortHint({ difficulty: 3, summary: 'Straightforward.' })).toBe('Straightforward.')
    expect(effortHint({ difficulty: 3 })).toBeNull()
  })
})
