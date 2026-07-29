import { describe, expect, it } from 'vitest'
import type { LlmCallMetricSummary } from '../ports/llm-metrics.js'
import {
  foldRollupTotals,
  foldRollupsByAgentKind,
  foldRollupsByPhase,
  rollupInputTokens,
} from './llm-rollup.js'

function cell(overrides: Partial<LlmCallMetricSummary> = {}): LlmCallMetricSummary {
  return {
    agentKind: 'coder',
    phase: 'agent',
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
