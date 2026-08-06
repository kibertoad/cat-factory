import { describe, expect, it } from 'vitest'
import type { LlmCallMetric } from '@cat-factory/kernel'
import {
  buildLlmMetricsExport,
  computeStoredPrompt,
  hashPrompt,
  outputHeadroomRatio,
  reconstructPrompts,
  transportOverheadRatio,
} from './observability.logic.js'

function metric(overrides: Partial<LlmCallMetric> & Pick<LlmCallMetric, 'id'>): LlmCallMetric {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    createdAt: 1,
    streaming: false,
    phase: 'agent',
    turnIndex: null,
    messageCount: 2,
    toolCount: 1,
    requestMaxTokens: 1000,
    promptTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 50,
    totalTokens: 150,
    finishReason: 'stop',
    upstreamMs: 200,
    overheadMs: 50,
    totalMs: 250,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    promptPrefixCount: 0,
    promptHash: '',
    responseText: 'ok',
    reasoningText: '',
    ...overrides,
  }
}

describe('outputHeadroomRatio', () => {
  it('is the peak fraction of the ceiling, capped at 1', () => {
    expect(outputHeadroomRatio(500, 1000)).toBe(0.5)
    expect(outputHeadroomRatio(1200, 1000)).toBe(1)
  })
  it('is null when the ceiling is unknown', () => {
    expect(outputHeadroomRatio(500, null)).toBeNull()
    expect(outputHeadroomRatio(500, 0)).toBeNull()
  })
})

describe('transportOverheadRatio', () => {
  it('is the overhead share of total latency', () => {
    expect(transportOverheadRatio(150, 50)).toBe(0.25)
  })
  it('is null with no timing', () => {
    expect(transportOverheadRatio(0, 0)).toBeNull()
  })
})

describe('buildLlmMetricsExport', () => {
  it('aggregates totals + per-agent insights with derived ratios', () => {
    const calls: LlmCallMetric[] = [
      metric({
        id: 'a',
        agentKind: 'coder',
        promptTokens: 200,
        cacheReadTokens: 150,
        cacheWriteTokens: 50,
        completionTokens: 50,
        requestMaxTokens: 1000,
        upstreamMs: 100,
        overheadMs: 10,
      }),
      metric({
        id: 'b',
        agentKind: 'coder',
        promptTokens: 200,
        cacheReadTokens: 400,
        cacheWriteTokens: 50,
        completionTokens: 990,
        requestMaxTokens: 1000,
        finishReason: 'length',
        upstreamMs: 300,
        overheadMs: 30,
      }),
      metric({
        id: 'c',
        agentKind: 'reviewer',
        ok: false,
        finishReason: null,
        completionTokens: 0,
        upstreamMs: 5,
        overheadMs: 5,
      }),
    ]
    const out = buildLlmMetricsExport('exec-1', calls, 12345)

    expect(out.kind).toBe('cat-factory.llm-metrics-export')
    expect(out.version).toBe(1)
    expect(out.executionId).toBe('exec-1')
    expect(out.generatedAt).toBe(12345)
    expect(out.calls).toHaveLength(3)

    expect(out.totals.calls).toBe(3)
    expect(out.totals.completionTokens).toBe(1040)
    expect(out.totals.errors).toBe(1)
    expect(out.totals.warnings).toBe(1)
    expect(out.totals.truncatedCalls).toBe(1)
    // overhead 45 / (405 upstream + 45 overhead) = 0.1
    expect(out.totals.transportOverheadRatio).toBeCloseTo(0.1, 5)

    const coder = out.insights.find((i) => i.agentKind === 'coder')!
    expect(coder.calls).toBe(2)
    expect(coder.peakCompletionTokens).toBe(990)
    expect(coder.maxOutputTokens).toBe(1000)
    expect(coder.outputHeadroomRatio).toBe(0.99)
    expect(coder.truncatedCalls).toBe(1)
    expect(coder.warnings).toBe(1)
    // The two cache classes stay APART in the rollup — summing them would make a run that
    // re-writes its prefix every turn read identically to one riding a warm cache.
    expect(coder.cacheReadTokens).toBe(550)
    expect(coder.cacheWriteTokens).toBe(100)
    // (550 read + 100 write) / (400 fresh + 550 read + 100 write) across the two coder calls.
    expect(coder.cacheHitRate).toBeCloseTo(650 / 1050, 5)
    expect(out.totals.cacheReadTokens).toBe(550)
    expect(out.totals.cacheWriteTokens).toBe(100)

    const reviewer = out.insights.find((i) => i.agentKind === 'reviewer')!
    expect(reviewer.errors).toBe(1)
  })

  it('reports null ratios for an empty run', () => {
    const out = buildLlmMetricsExport('exec-empty', [], 1)
    expect(out.totals.calls).toBe(0)
    expect(out.totals.transportOverheadRatio).toBeNull()
    expect(out.insights).toEqual([])
  })

  it('reconstructs full prompts from stored deltas in the export', () => {
    const sys = { role: 'system' }
    const u = { role: 'user' }
    const a = { role: 'assistant' }
    const full1 = JSON.stringify([sys, u])
    const c1 = metric({
      id: 'c1',
      createdAt: 10,
      promptText: full1,
      promptPrefixCount: 0,
      promptHash: hashPrompt(full1),
    })
    // c2 stored as a delta of the two new messages, eliding the 2-message prefix.
    const c2 = metric({
      id: 'c2',
      createdAt: 20,
      promptText: JSON.stringify([a, u]),
      promptPrefixCount: 2,
      promptHash: hashPrompt(JSON.stringify([sys, u, a, u])),
    })
    const out = buildLlmMetricsExport('exec-1', [c2, c1], 1)
    const byId = Object.fromEntries(out.calls.map((c) => [c.id, c]))
    expect(JSON.parse(byId.c2!.promptText)).toEqual([sys, u, a, u])
    expect(byId.c2!.promptPrefixCount).toBe(0)
  })
})

describe('computeStoredPrompt', () => {
  const sys = { role: 'system', content: 's' }
  const u = { role: 'user', content: 'u' }
  const a = { role: 'assistant', content: 'a' }

  it('stores the full array when there is no previous call', () => {
    const full = JSON.stringify([sys, u])
    const stored = computeStoredPrompt(full, null)
    expect(stored.promptPrefixCount).toBe(0)
    expect(stored.promptText).toBe(full)
    expect(stored.promptHash).toBe(hashPrompt(full))
  })

  it('stores only the appended messages when the call extends the previous one', () => {
    const prevFull = JSON.stringify([sys, u])
    const full = JSON.stringify([sys, u, a, u])
    const stored = computeStoredPrompt(full, {
      messageCount: 2,
      promptHash: hashPrompt(prevFull),
    })
    expect(stored.promptPrefixCount).toBe(2)
    expect(JSON.parse(stored.promptText)).toEqual([a, u])
  })

  it('falls back to full when the prefix hash does not match (compaction / restart)', () => {
    const full = JSON.stringify([{ role: 'system', content: 'different' }, u])
    const stored = computeStoredPrompt(full, { messageCount: 1, promptHash: 'stale-hash' })
    expect(stored.promptPrefixCount).toBe(0)
    expect(stored.promptText).toBe(full)
  })

  it('round-trips: a chain of deltas reconstructs to the original full prompts', () => {
    const fulls = [
      [sys, u],
      [sys, u, a, u],
      [sys, u, a, u, a, u],
    ].map((m) => JSON.stringify(m))
    let tip: { messageCount: number; promptHash: string } | null = null
    const calls = fulls.map((full, i) => {
      const stored = computeStoredPrompt(full, tip)
      tip = { messageCount: JSON.parse(full).length, promptHash: stored.promptHash }
      return metric({
        id: `c${i}`,
        createdAt: i,
        messageCount: JSON.parse(full).length,
        promptText: stored.promptText,
        promptPrefixCount: stored.promptPrefixCount,
        promptHash: stored.promptHash,
      })
    })
    // At least one call was actually compressed (stored a delta).
    expect(calls.some((c) => c.promptPrefixCount > 0)).toBe(true)
    const rebuilt = reconstructPrompts(calls)
    rebuilt.forEach((c, i) => expect(c.promptText).toBe(fulls[i]))
  })

  it('reconstructs correctly when calls share a createdAt (ordered by message count)', () => {
    // Records are written off the response path (waitUntil), so chained calls can land
    // in the SAME createdAt millisecond — and with ids that sort the wrong way. The
    // monotonic message count must still replay them in true conversation order.
    const fulls = [
      [sys, u],
      [sys, u, a, u],
      [sys, u, a, u, a, u],
    ].map((m) => JSON.stringify(m))
    let tip: { messageCount: number; promptHash: string } | null = null
    const calls = fulls.map((full, i) => {
      const stored = computeStoredPrompt(full, tip)
      tip = { messageCount: JSON.parse(full).length, promptHash: stored.promptHash }
      return metric({
        // Descending ids (c2, c1, c0) so an id-only tiebreak would reverse the chain.
        id: `c${fulls.length - 1 - i}`,
        createdAt: 100,
        messageCount: JSON.parse(full).length,
        promptText: stored.promptText,
        promptPrefixCount: stored.promptPrefixCount,
        promptHash: stored.promptHash,
      })
    })
    const rebuilt = reconstructPrompts(calls)
    // `rebuilt` preserves input order, so each call still maps to its original full prompt.
    rebuilt.forEach((c, i) => expect(c.promptText).toBe(fulls[i]))
  })
})

describe('buildLlmMetricsExport — pricing', () => {
  const rates = () => ({
    inputPerMillion: 1_000_000,
    cacheReadPerMillion: 100_000,
    cacheWritePerMillion: 1_250_000,
    outputPerMillion: 5_000_000,
  })
  const calls = [
    metric({
      id: 'a',
      agentKind: 'coder',
      promptTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      completionTokens: 1,
    }),
  ]

  it('prices each input class at its own tier', () => {
    // 1 + 0.1 + 1.25 + 5, the same arithmetic (kernel's `costOfTokenClasses`) the rollup and
    // the ledger use, so the export cannot disagree with the surfaces beside it.
    const out = buildLlmMetricsExport('exec-1', calls, 1, { rates })
    expect(out.totals.costEstimate).toBeCloseTo(7.35, 10)
    expect(out.truncated).toBe(false)
  })

  it('declines to price a TRUNCATED bundle rather than costing a slice as the whole run', () => {
    // The cap is what makes this necessary: the slice's sum is a smaller number that still
    // reads as a total, and this bundle exists to be handed to a model that would quote it.
    const out = buildLlmMetricsExport('exec-1', calls, 1, { rates, truncated: true })
    expect(out.truncated).toBe(true)
    expect(out.totals.costEstimate).toBeNull()
    expect(out.insights.every((i) => i.costEstimate === null)).toBe(true)
    // The token counts are still reported — partial, and now labelled as such.
    expect(out.totals.completionTokens).toBe(1)
  })

  it('reports null costs when nothing prices the calls', () => {
    const out = buildLlmMetricsExport('exec-1', calls, 1)
    expect(out.totals.costEstimate).toBeNull()
  })
})
