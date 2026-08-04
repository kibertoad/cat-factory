import type { RetentionConfig } from '@cat-factory/server'
import { createRecordingLogger } from '@cat-factory/kernel'
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
  cutoffs: {
    tokenUsage: number | null
    llmCallMetrics: number | null
    agentContextSnapshots: number | null
    agentSearchQueries: number | null
    subscriptionQuotaCycles: number | null
    provisioningLog: number | null
    commits: number | null
    notifications: number | null
    gateOutcomes: number | null
    runDays: number | null
    rollup: [number, number] | null
  }
} {
  const cutoffs = {
    tokenUsage: null as number | null,
    llmCallMetrics: null as number | null,
    agentContextSnapshots: null as number | null,
    agentSearchQueries: null as number | null,
    subscriptionQuotaCycles: null as number | null,
    provisioningLog: null as number | null,
    commits: null as number | null,
    notifications: null as number | null,
    gateOutcomes: null as number | null,
    runDays: null as number | null,
    /** The [from, to) window the rollup pass recomputed. */
    rollup: null as [number, number] | null,
  }
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
      // Agent-context snapshots ride the same window as llmCallMetrics.
      agentContextSnapshotRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.agentContextSnapshots = c
          return 5
        },
      },
      // Agent-search queries ride the same window as llmCallMetrics.
      agentSearchQueryRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.agentSearchQueries = c
          return 6
        },
      },
      // Recurring-pipeline run history prune (fixed ~1-week window). Returns 0 here;
      // its real behaviour is covered against Postgres by the conformance suite.
      pipelineScheduleRepository: { pruneRunsBefore: async () => 0 },
      // Expired personal-credential activations (deleted by `now`, not a window).
      subscriptionActivationRepository: { deleteExpired: async () => 2 },
      // Idle quota cycles pruned to the fixed 30-day window.
      subscriptionQuotaCycleRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.subscriptionQuotaCycles = c
          return 8
        },
      },
      provisioningLogRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.provisioningLog = c
          return 5
        },
      },
      // Expired password-reset tokens (deleted by `now`, not a window).
      passwordResetTokenRepository: { deleteExpired: async () => 1 },
      // Machine-node roster rows past their latest signed exp (deleted by `now`).
      machineNodeRepository: { deleteExpired: async () => 2 },
      // Password-throttle attempts, pruned to a fixed 1-hour window.
      authAttemptRepository: { deleteOlderThan: async () => 4 },
      // GitHub commit projection, pruned to the `commitMs` window (Worker parity).
      commitRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.commits = c
          return 4
        },
      },
      // Resolved notifications, pruned to the `notificationsMs` window (Worker parity).
      notificationRepository: {
        deleteResolvedOlderThan: async (c) => {
          cutoffs.notifications = c
          return 9
        },
      },
      gateOutcomeRepository: {
        deleteOlderThan: async (c) => {
          cutoffs.gateOutcomes = c
          return 2
        },
      },
      platformMetricsRepository: {
        rollupRunDays: async (from, to) => {
          cutoffs.rollup = [from, to]
          return 11
        },
        deleteRunDaysOlderThan: async (c) => {
          cutoffs.runDays = c
          return 1
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
    provisioningLogMs: 14 * DAY,
    notificationsMs: 90 * DAY,
    gateOutcomesMs: 90 * DAY,
    runDaysMs: 400 * DAY,
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
    expect(cutoffs.agentContextSnapshots).toBe(now - 3 * DAY) // same window as llmCallMetrics
    expect(cutoffs.agentSearchQueries).toBe(now - 3 * DAY) // same window as llmCallMetrics
    expect(cutoffs.provisioningLog).toBe(now - 14 * DAY)
    expect(cutoffs.commits).toBe(now - 90 * DAY)
    expect(cutoffs.subscriptionQuotaCycles).toBe(now - 30 * DAY) // fixed 30-day window
    expect(cutoffs.notifications).toBe(now - 90 * DAY)
    expect(cutoffs.gateOutcomes).toBe(now - 90 * DAY)
    expect(cutoffs.runDays).toBe(now - 400 * DAY)
    // The rollup recomputes a short trailing lookback, so a missed pass self-heals instead of
    // leaving a day permanently half-counted.
    expect(cutoffs.rollup).toEqual([now - 3 * DAY, now])
    expect(result).toEqual({
      tokenUsage: 3,
      llmCallMetrics: 7,
      agentContextSnapshots: 5,
      agentSearchQueries: 6,
      scheduleRuns: 0,
      activations: 2,
      subscriptionQuotaCycles: 8,
      provisioningLog: 5,
      passwordResetTokens: 1,
      machineNodes: 2,
      authAttempts: 4,
      commits: 4,
      notifications: 9,
      gateOutcomes: 2,
      runDays: 1,
      runDaysRolledUp: 11,
      failedTables: [],
    })
  })

  it('treats a non-positive window as disabled — no delete, zero reclaimed', async () => {
    const { repos, cutoffs } = fakeRepos()
    const result = await sweepRetention(repos, policy({ llmCallMetricsMs: 0 }), now)

    expect(cutoffs.tokenUsage).toBe(now - 30 * DAY) // still pruned
    expect(cutoffs.llmCallMetrics).toBeNull() // disabled → never called
    expect(cutoffs.agentContextSnapshots).toBeNull() // same disabled window → never called
    expect(cutoffs.agentSearchQueries).toBeNull() // same disabled window → never called
    expect(result).toEqual({
      tokenUsage: 3,
      llmCallMetrics: 0,
      agentContextSnapshots: 0,
      agentSearchQueries: 0,
      scheduleRuns: 0,
      activations: 2,
      subscriptionQuotaCycles: 8,
      provisioningLog: 5,
      passwordResetTokens: 1,
      machineNodes: 2,
      authAttempts: 4,
      commits: 4,
      notifications: 9,
      gateOutcomes: 2,
      runDays: 1,
      // The rollup is a WRITE, not a prune: disabling a RETENTION window says "never delete",
      // never "stop materialising", so it still runs.
      runDaysRolledUp: 11,
      failedTables: [],
    })
  })

  it('treats a non-positive commit window as disabled (full history kept)', async () => {
    const { repos, cutoffs } = fakeRepos()
    const result = await sweepRetention(repos, policy({ commitMs: 0 }), now)

    expect(cutoffs.commits).toBeNull()
    expect(result.commits).toBe(0)
  })

  it('isolates a failing table: the rest of the pass still prunes, and the failure is named', async () => {
    // The regression this exists for: the passes used to be a chain of bare `await`s, so the
    // FIRST failing prune aborted every later one — and did so on every pass thereafter, which
    // silently stopped all telemetry pruning behind one generic "sweep failed" line.
    const { repos, cutoffs } = fakeRepos()
    repos.llmCallMetricRepository.deleteOlderThan = async () => {
      throw new Error('relation is locked')
    }
    const logger = createRecordingLogger()

    const result = await sweepRetention(repos, policy(), now, logger)

    // The tables AFTER the failing one still ran — that is the whole fix.
    expect(cutoffs.agentContextSnapshots).toBe(now - 3 * DAY)
    expect(cutoffs.notifications).toBe(now - 90 * DAY)
    expect(result.notifications).toBe(9)
    // …and the failure is REPORTED rather than reading as an empty table: 0 reclaimed is what a
    // clean prune of an empty table also returns, so only `failedTables` tells them apart.
    expect(result.llmCallMetrics).toBe(0)
    expect(result.failedTables).toEqual(['llm_call_metrics'])
    const warned = logger.lines.find((line) => line.msg.includes('pruning one table failed'))
    expect(warned?.fields?.table).toBe('llm_call_metrics')
  })
})
