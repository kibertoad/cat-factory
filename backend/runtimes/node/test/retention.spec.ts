import type { RetentionConfig } from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { type RetentionRepos, sweepRetention } from '../src/retention.js'

// Pure unit coverage for the Node retention sweep (no database). The repository-level
// `deleteOlderThan` behaviour is covered against real Postgres by the conformance and
// llm-metrics suites; here we assert the sweep's policy: correct cutoffs and that a
// non-positive window disables a table's pass entirely.

const DAY = 24 * 60 * 60 * 1000

/** A repo pair that records the cutoff each prune was asked for (or `null` if skipped). */
function fakeRepos(): {
  repos: RetentionRepos
  cutoffs: { tokenUsage: number | null; llmCallMetrics: number | null }
} {
  const cutoffs = { tokenUsage: null as number | null, llmCallMetrics: null as number | null }
  return {
    cutoffs,
    repos: {
      tokenUsageRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.tokenUsage = c
          return 3
        },
      },
      llmCallMetricRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.llmCallMetrics = c
          return 7
        },
      },
    },
  }
}

function policy(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    tokenUsageMs: 30 * DAY,
    rateLimitMs: 7 * DAY,
    commitMs: 90 * DAY,
    llmCallMetricsMs: 3 * DAY,
    ...overrides,
  }
}

describe('sweepRetention', () => {
  const now = 1_000 * DAY

  it('prunes each table at now - its configured window and returns the counts', async () => {
    const { repos, cutoffs } = fakeRepos()
    const result = await sweepRetention(repos, policy(), now)

    expect(cutoffs.tokenUsage).toBe(now - 30 * DAY)
    expect(cutoffs.llmCallMetrics).toBe(now - 3 * DAY)
    expect(result).toEqual({ tokenUsage: 3, llmCallMetrics: 7 })
  })

  it('treats a non-positive window as disabled — no delete, zero reclaimed', async () => {
    const { repos, cutoffs } = fakeRepos()
    const result = await sweepRetention(repos, policy({ llmCallMetricsMs: 0 }), now)

    expect(cutoffs.tokenUsage).toBe(now - 30 * DAY) // still pruned
    expect(cutoffs.llmCallMetrics).toBeNull() // disabled → never called
    expect(result).toEqual({ tokenUsage: 3, llmCallMetrics: 0 })
  })
})
