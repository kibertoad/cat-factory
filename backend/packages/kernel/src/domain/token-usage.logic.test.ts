import { describe, expect, it } from 'vitest'
import {
  agentUsageFromHarnessCalls,
  partitionInputTokens,
  sumAgentTokenUsage,
} from './token-usage.logic.js'

describe('partitionInputTokens', () => {
  it('leaves the total intact and gives the unclaimed remainder to fresh input', () => {
    const classes = partitionInputTokens(1000, { cacheReadTokens: 600, cacheWriteTokens: 100 })
    expect(classes).toEqual({
      promptTokens: 300,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
    })
    // The invariant the meter depends on: what is priced is exactly what is stored.
    expect(classes.promptTokens + classes.cacheReadTokens + classes.cacheWriteTokens).toBe(1000)
  })

  it('clamps cache shares that overshoot the total instead of minting negative fresh input', () => {
    // The two channels disagreed. Read comes off first, and write takes only what is left.
    expect(partitionInputTokens(1000, { cacheReadTokens: 900, cacheWriteTokens: 400 })).toEqual({
      promptTokens: 0,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    })
    expect(partitionInputTokens(100, { cacheReadTokens: 500, cacheWriteTokens: 0 })).toEqual({
      promptTokens: 0,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    })
  })

  it('treats a negative count from either side as 0', () => {
    expect(partitionInputTokens(-5, { cacheReadTokens: 10, cacheWriteTokens: 0 })).toEqual({
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(partitionInputTokens(100, { cacheReadTokens: -10, cacheWriteTokens: 20 })).toEqual({
      promptTokens: 80,
      cacheReadTokens: 0,
      cacheWriteTokens: 20,
    })
  })
})

describe('sumAgentTokenUsage', () => {
  it('adds the totals and the classes when both parts reported a split', () => {
    expect(
      sumAgentTokenUsage(
        {
          inputTokens: 100,
          outputTokens: 10,
          inputClasses: { promptTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10 },
        },
        {
          inputTokens: 200,
          outputTokens: 20,
          inputClasses: { promptTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0 },
        },
      ),
    ).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      inputClasses: { promptTokens: 140, cacheReadTokens: 150, cacheWriteTokens: 10 },
    })
  })

  it('drops the split when either part reported none', () => {
    // Absent is not zero: the aggregate must not claim the unsplit part cached nothing, so it
    // falls back to lump pricing, which over-states rather than under-states.
    const summed = sumAgentTokenUsage(
      {
        inputTokens: 100,
        outputTokens: 10,
        inputClasses: { promptTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10 },
      },
      { inputTokens: 200, outputTokens: 20 },
    )
    expect(summed).toEqual({ inputTokens: 300, outputTokens: 30 })
    expect(summed).not.toHaveProperty('inputClasses')
  })

  it('passes a lone part through untouched, split and all', () => {
    const only = {
      inputTokens: 100,
      outputTokens: 10,
      inputClasses: { promptTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10 },
    }
    expect(sumAgentTokenUsage(undefined, only)).toEqual(only)
    expect(sumAgentTokenUsage(only, undefined)).toEqual(only)
    expect(sumAgentTokenUsage(undefined, undefined)).toBeUndefined()
  })
})

describe('agentUsageFromHarnessCalls', () => {
  it('keeps the harness total and folds only the cache shares off the per-call rows', () => {
    expect(
      agentUsageFromHarnessCalls({ inputTokens: 1_000, outputTokens: 100 }, [
        { cacheReadTokens: 400, cacheWriteTokens: 50 },
        { cacheReadTokens: 300, cacheWriteTokens: 0 },
      ]),
    ).toEqual({
      inputTokens: 1_000,
      outputTokens: 100,
      inputClasses: { promptTokens: 250, cacheReadTokens: 700, cacheWriteTokens: 50 },
    })
  })

  it('prices a turn the CLI narrated no per-call usage for as FRESH, never by shrinking the total', () => {
    // The per-call rows fall short of the terminal cumulative on some CLIs. The gap is the one
    // thing the split may not swallow: under-counting the total under-charges the budget.
    const usage = agentUsageFromHarnessCalls({ inputTokens: 1_000, outputTokens: 0 }, [
      { cacheReadTokens: 100, cacheWriteTokens: 0 },
    ])
    expect(usage.inputTokens).toBe(1_000)
    expect(usage.inputClasses).toEqual({
      promptTokens: 900,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    })
  })

  it('reports NO split when the harness streamed no per-call telemetry', () => {
    // A proxy-metered harness, or a CLI build that narrates nothing: the lump is then priced
    // entirely at the fresh rate rather than claiming nothing was cached.
    const usage = agentUsageFromHarnessCalls({ inputTokens: 500, outputTokens: 20 }, undefined)
    expect(usage).toEqual({ inputTokens: 500, outputTokens: 20 })
    expect(
      agentUsageFromHarnessCalls({ inputTokens: 500, outputTokens: 20 }, []),
    ).not.toHaveProperty('inputClasses')
  })
})
