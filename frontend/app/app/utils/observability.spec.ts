import { describe, it, expect } from 'vitest'
import type { PipelineStep, StepPhaseMetrics } from '~/types/execution'
import { foldRunPhaseMetrics, formatCost, sumCosts, totalInputTokens } from './observability'

describe('totalInputTokens', () => {
  it('sums all three input classes, so the headline matches Claude Code’s context gauge', () => {
    expect(
      totalInputTokens({ promptTokens: 685, cacheReadTokens: 31_099_813, cacheWriteTokens: 0 }),
    ).toBe(31_100_498)
  })

  it('counts cache WRITES too — they occupy the window like any other input token', () => {
    expect(
      totalInputTokens({ promptTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 40 }),
    ).toBe(1040)
  })

  it('does NOT lead with the fresh figure on a cache-dominated run', () => {
    // The regression this pins: leading with fresh made a ~31M-token run render as 685 tokens,
    // discounting cache reads because their dollar cost is low. Volume is the thing being
    // measured here, and a cached token costs the same context window as a fresh one.
    const m = { promptTokens: 685, cacheReadTokens: 31_099_813, cacheWriteTokens: 0 }
    expect(totalInputTokens(m)).toBeGreaterThan(m.promptTokens * 1000)
  })

  it('degrades to the fresh count when an older snapshot carries no cache fields', () => {
    expect(totalInputTokens({ promptTokens: 500 })).toBe(500)
  })
})

describe('foldRunPhaseMetrics', () => {
  const phase = (over: Partial<StepPhaseMetrics> & Pick<StepPhaseMetrics, 'phase'>) => ({
    calls: 1,
    promptTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 5,
    carryCostTokens: 0,
    errors: 0,
    ...over,
  })
  const step = (agentKind: string, byPhase: StepPhaseMetrics[]) =>
    ({ agentKind, metrics: { byPhase } }) as unknown as PipelineStep

  it('does NOT double-count two steps that share an agent kind', () => {
    // A step's rollup covers its agent KIND across the whole run (the proxy keys a conversation
    // by `(execution, agentKind)`), so two tester steps carry identical numbers. Summing them
    // would report twice the tokens the run actually spent.
    const rows = [phase({ phase: 'agent', calls: 3, carryCostTokens: 90 })]
    const folded = foldRunPhaseMetrics([step('tester', rows), step('tester', rows)])
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({ phase: 'agent', calls: 3, carryCostTokens: 90 })
  })

  it('merges a phase across different agent kinds and sorts costliest first', () => {
    const folded = foldRunPhaseMetrics([
      step('coder', [
        phase({ phase: 'agent', calls: 2, carryCostTokens: 10 }),
        phase({ phase: 'validation-repair', calls: 1, carryCostTokens: 500 }),
      ]),
      step('reviewer', [phase({ phase: 'agent', calls: 4, carryCostTokens: 40 })]),
    ])
    expect(folded.map((p) => [p.phase, p.calls, p.carryCostTokens])).toEqual([
      ['validation-repair', 1, 500],
      ['agent', 6, 50],
    ])
  })

  it("keeps the unattributed '' phase rather than hiding it", () => {
    const folded = foldRunPhaseMetrics([step('coder', [phase({ phase: '', calls: 7 })])])
    expect(folded.map((p) => p.phase)).toEqual([''])
  })

  it('is empty when no step carries a rollup, so the section simply does not render', () => {
    expect(foldRunPhaseMetrics([{ agentKind: 'coder' } as unknown as PipelineStep])).toEqual([])
  })

  it('returns fresh rows rather than aliasing the store objects it folded', () => {
    // The single-kind case is the one that used to pass a `step.metrics.byPhase` row straight
    // through: a caller mutating what a fold handed it would have written into the store.
    const row = phase({ phase: 'agent', calls: 3, carryCostTokens: 90 })
    const folded = foldRunPhaseMetrics([step('coder', [row])])
    expect(folded[0]).not.toBe(row)
    folded[0]!.calls = 999
    expect(row.calls).toBe(3)
  })
})

describe('formatCost', () => {
  it('omits the figure entirely when nothing priced it', () => {
    // Null, never "0.00": a deployment that cannot price a model and a step that cost nothing
    // are opposite facts, and rendering both as zero states the wrong one confidently.
    expect(formatCost(null, 'EUR')).toBeNull()
    expect(formatCost(undefined, 'EUR')).toBeNull()
    // A genuine zero still renders — it is a real, priced answer.
    expect(formatCost(0, 'EUR')).toBe('0.00 EUR')
  })

  it('keeps more decimals under a unit, where most steps land', () => {
    expect(formatCost(0.0037, 'EUR')).toBe('0.0037 EUR')
    expect(formatCost(12.5, 'EUR')).toBe('12.50 EUR')
  })

  it('shows a threshold rather than rounding a real cost down to zero', () => {
    // `0.0000` makes a priced-but-tiny step read as free — the same claim the null case is
    // careful not to make. A cheap step is not a free one.
    expect(formatCost(0.00001, 'EUR')).toBe('<0.0001 EUR')
    expect(formatCost(0.0001, 'EUR')).toBe('0.0001 EUR')
  })

  it('labels the amount with the currency it was priced in rather than assuming one', () => {
    // The price table's currency is operator-configured; the built-in one is EUR, not USD.
    expect(formatCost(1, 'USD')).toBe('1.00 USD')
    expect(formatCost(1)).toBe('1.00')
  })
})

describe('sumCosts', () => {
  it('adds the parts it can price', () => {
    expect(sumCosts([1, 2, 0.5])).toBe(3.5)
    expect(sumCosts([])).toBe(0)
  })

  it('declines to answer when any part is unpriced, rather than under-reporting', () => {
    // A total that silently dropped its unpriceable term is a smaller number that still reads
    // as complete — strictly worse than no number.
    expect(sumCosts([1, null, 2])).toBeNull()
    expect(sumCosts([undefined])).toBeNull()
  })
})
