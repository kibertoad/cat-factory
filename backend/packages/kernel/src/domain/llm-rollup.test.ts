import { describe, expect, it } from 'vitest'
import type { LlmCallMetricSummary } from '../ports/llm-metrics.js'
import {
  type LlmRateResolver,
  foldRollupTotals,
  foldRollupsByAgentKind,
  foldRollupsByPhase,
  priceRollupCells,
  rollupInputTokens,
} from './llm-rollup.js'

function cell(overrides: Partial<LlmCallMetricSummary> = {}): LlmCallMetricSummary {
  return {
    agentKind: 'coder',
    phase: 'agent',
    provider: 'anthropic',
    model: 'claude-opus-5',
    calls: 1,
    promptTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    completionTokens: 20,
    peakCompletionTokens: 20,
    maxOutputTokens: 1_000,
    truncatedCalls: 0,
    upstreamMs: 100,
    overheadMs: 10,
    errors: 0,
    warnings: 0,
    carryCostTokens: 34,
    costEstimate: null,
    ...overrides,
  }
}

describe('foldRollupTotals', () => {
  it('sums the additive figures and MAXes the extremes', () => {
    const totals = foldRollupTotals([
      cell({ calls: 2, completionTokens: 30, peakCompletionTokens: 25, maxOutputTokens: 1_000 }),
      cell({
        phase: 'validation-repair',
        calls: 3,
        completionTokens: 5,
        peakCompletionTokens: 4,
        maxOutputTokens: 8_000,
      }),
    ])
    expect(totals.calls).toBe(5)
    expect(totals.completionTokens).toBe(35)
    // A ceiling is an extreme, not a total: summing two steps' `max_tokens` would invent an
    // output limit no request ever asked for.
    expect(totals.peakCompletionTokens).toBe(25)
    expect(totals.maxOutputTokens).toBe(8_000)
  })

  it('lets a known ceiling win over an unknown one instead of being poisoned by it', () => {
    expect(
      foldRollupTotals([cell({ maxOutputTokens: null }), cell({ maxOutputTokens: 4_096 })])
        .maxOutputTokens,
    ).toBe(4_096)
    expect(foldRollupTotals([cell({ maxOutputTokens: null })]).maxOutputTokens).toBeNull()
  })

  it('is zero-valued for an empty run rather than undefined', () => {
    const totals = foldRollupTotals([])
    expect(totals.calls).toBe(0)
    expect(totals.carryCostTokens).toBe(0)
    expect(totals.maxOutputTokens).toBeNull()
  })
})

describe('foldRollupsByAgentKind / foldRollupsByPhase', () => {
  const cells = [
    cell({ agentKind: 'coder', phase: 'agent', calls: 2, carryCostTokens: 400 }),
    cell({ agentKind: 'coder', phase: 'validation-repair', calls: 1, carryCostTokens: 0 }),
    cell({ agentKind: 'reviewer', phase: 'agent', calls: 4, carryCostTokens: 90 }),
    cell({ agentKind: 'reviewer', phase: '', calls: 3, carryCostTokens: 10 }),
  ]

  it('folds the same cells along either axis to the same run total', () => {
    const byKind = foldRollupsByAgentKind(cells)
    const byPhase = foldRollupsByPhase(cells)
    const sum = (rows: { calls: number; carryCostTokens: number }[]) => ({
      calls: rows.reduce((a, r) => a + r.calls, 0),
      carry: rows.reduce((a, r) => a + r.carryCostTokens, 0),
    })
    // The whole reason both breakdowns are folds over ONE aggregate: two independent
    // queries would be free to disagree with each other and with the totals above them.
    expect(sum(byKind)).toEqual({ calls: 10, carry: 500 })
    expect(sum(byPhase)).toEqual({ calls: 10, carry: 500 })
    const totals = foldRollupTotals(cells)
    expect({ calls: totals.calls, carry: totals.carryCostTokens }).toEqual({
      calls: 10,
      carry: 500,
    })
  })

  it('collapses a phase spread across agent kinds into one row', () => {
    const agent = foldRollupsByPhase(cells).find((p) => p.phase === 'agent')!
    expect(agent.calls).toBe(6)
    expect(agent.carryCostTokens).toBe(490)
  })

  it("keeps the unattributed '' phase as a real row", () => {
    // Dropping it would make "metered by a channel with no phase concept" read exactly like
    // "spent nothing outside the agent", while the table still looked complete.
    const unattributed = foldRollupsByPhase(cells).find((p) => p.phase === '')
    expect(unattributed?.calls).toBe(3)
  })
})

describe('rollupInputTokens', () => {
  it('is the sum of the three orthogonal input classes', () => {
    expect(rollupInputTokens(foldRollupTotals([cell()]))).toBe(17)
  })
})

describe('priceRollupCells', () => {
  const rates: LlmRateResolver = (provider, model) =>
    provider === 'anthropic' && model === 'claude-opus-5'
      ? {
          inputPerMillion: 1_000_000,
          cacheReadPerMillion: 100_000,
          cacheWritePerMillion: 1_250_000,
          outputPerMillion: 5_000_000,
        }
      : null

  it('prices each class at its own rate rather than the fresh one', () => {
    const [priced] = priceRollupCells(
      [cell({ promptTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, completionTokens: 1 })],
      rates,
    )
    // 1 + 0.1 + 1.25 + 5. Pricing the three input classes as one lumped `3` at the fresh rate
    // would say 8 — the over-count that exhausted budgets on cache-read-dominated runs.
    expect(priced?.costEstimate).toBeCloseTo(7.35, 10)
  })

  it('collapses the model dimension, summing the costs it priced separately', () => {
    const priced = priceRollupCells(
      [
        cell({ promptTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, completionTokens: 0 }),
        cell({ promptTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, completionTokens: 0 }),
      ],
      rates,
    )
    expect(priced).toHaveLength(1)
    expect(priced[0]?.calls).toBe(2)
    expect(priced[0]?.costEstimate).toBeCloseTo(3, 10)
  })

  it('leaves a cell null when the deployment cannot price its model', () => {
    // Null, never 0: an unpriced model and a free one are opposite facts.
    const [priced] = priceRollupCells([cell({ provider: 'mystery', model: 'x' })], rates)
    expect(priced?.costEstimate).toBeNull()
  })

  it('contaminates a fold with one unpriced cell rather than under-reporting the total', () => {
    const priced = priceRollupCells(
      [
        cell({ promptTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, completionTokens: 0 }),
        cell({ provider: 'mystery', model: 'x', phase: 'validation-repair' }),
      ],
      rates,
    )
    expect(foldRollupTotals(priced).costEstimate).toBeNull()
    // The priced cell still reports its own cost — only the TOTAL declines to answer.
    expect(priced.find((p) => p.phase === 'agent')?.costEstimate).toBeCloseTo(1, 10)
  })
})
