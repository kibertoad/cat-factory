import type { Meta, StoryObj } from '@storybook/vue3'
import type { PlatformObservability, PlatformObservabilityWindow } from '~/types/execution'
import { getPlatformObservabilityContract } from '@cat-factory/contracts'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { expectTrendToScale } from '~/stories/trend'
import { withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { usePlatformObservabilityStore } from '~/stores/platformObservability'
import { useUiStore } from '~/stores/ui'
import OperatorDashboardPanel from './OperatorDashboardPanel.vue'

// The operator's dashboard for the active account, a full-screen overlay: run outcomes and the
// success rate, an outcome trend, the gates' fixer statistics, the failure kinds, the runs live
// now, and run durations, over a chosen window. The short windows are counted live from the runs;
// 30 and 90 days come from a daily rollup, and the dashboard says how far that rollup reaches.
// It loads the account's figures when it opens, so each story opens it and answers that read.
// The figures are made up; the failure kinds and gate kinds are the backend's.

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 11, 12, 0)

const meta = {
  title: 'Run telemetry/Pages/OperatorDashboardPanel',
  component: OperatorDashboardPanel,
  decorators: [withDashboard('24h')],
  parameters: { api: [figuresAre(platform())] },
} satisfies Meta<typeof OperatorDashboardPanel>
export default meta

type Story = StoryObj<typeof meta>

/** The Acme account active, the window chosen, and the dashboard open. */
function withDashboard(window: PlatformObservabilityWindow) {
  return withSeed(() => {
    const accounts = useAccountsStore()
    accounts.accounts = [orgAccount]
    accounts.activeAccountId = orgAccount.id
    usePlatformObservabilityStore().window = window
    useUiStore().openOperatorDashboard()
  })
}

function figuresAre(view: PlatformObservability) {
  return apiResponse(getPlatformObservabilityContract, {
    pathParams: { accountId: orgAccount.id },
    body: view,
  })
}

/**
 * A busy day: 24 hourly buckets, quieter overnight. They add up to the day's outcomes: 58 done,
 * 7 failed, and the 6 running, blocked or paused runs in the last hour.
 */
function hourlyTrend() {
  return Array.from({ length: 24 }, (_, i) => {
    const busy = i >= 8 && i <= 18
    return {
      start: NOW - DAY + i * HOUR,
      done: busy ? 4 + (i % 3) : i % 4 === 0 ? 1 : 0,
      failed: busy && i % 3 !== 2 ? 1 : 0,
      other: i === 23 ? 6 : 0,
    }
  })
}

/** The last day of the Acme account. */
function platform(overrides: Partial<PlatformObservability> = {}): PlatformObservability {
  return {
    window: '24h',
    generatedAt: NOW,
    since: NOW - DAY,
    outcomes: {
      total: 71,
      done: 58,
      failed: 7,
      running: 3,
      blocked: 2,
      paused: 1,
      other: 0,
      successRate: 58 / 65,
    },
    source: 'runs',
    rolledUpThrough: null,
    trend: { bucketMs: HOUR, points: hourlyTrend() },
    failures: [
      { kind: 'agent', count: 3 },
      { kind: 'dispatch', count: 2 },
      { kind: 'stalled', count: 1 },
      { kind: 'environment', count: 1 },
    ],
    gates: [
      {
        gateKind: 'ci',
        helperKind: 'ci-fixer',
        gates: 52,
        passed: 49,
        exhausted: 3,
        cleanPasses: 41,
        attempts: 17,
        helperFailures: 1,
      },
      {
        gateKind: 'conflicts',
        helperKind: 'conflict-resolver',
        gates: 50,
        passed: 50,
        exhausted: 0,
        cleanPasses: 46,
        attempts: 4,
        helperFailures: 0,
      },
    ],
    live: { running: 3, blocked: 2, paused: 1, pending: 0 },
    durations: {
      count: 65,
      avgMs: 23 * 60_000,
      minMs: 3 * 60_000 + 12_000,
      maxMs: 2 * HOUR + 14 * 60_000,
      p50Ms: 17 * 60_000,
      p90Ms: 48 * 60_000,
      p99Ms: 1 * HOUR + 52 * 60_000,
    },
    ...overrides,
  }
}

/** A daily trend over `days` days, for the rollup windows. */
function dailyTrend(days: number, through: number) {
  return Array.from({ length: days }, (_, i) => {
    const start = NOW - (days - i) * DAY
    return start > through
      ? { start, done: 0, failed: 0, other: 0 }
      : { start, done: 50 + (i % 7) * 3, failed: 4 + (i % 3), other: 0 }
  })
}

/**
 * The last 24 hours, counted live: the four tiles, the hourly trend, both gates with their clean
 * pass rates, four failure kinds, the runs live now, and the duration percentiles. Each trend
 * column draws at its hour's share of the busiest hour.
 */
export const Default: Story = {
  play: async () => {
    const totals = hourlyTrend().map((p) => p.done + p.failed + p.other)
    await expectTrendToScale('operator-trend', totals, 4)
  },
}

/** The first load in flight: placeholder blocks. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(getPlatformObservabilityContract, { pathParams: { accountId: orgAccount.id } }),
    ],
  },
}

/** The read failed: the client's message as it arrives, and Retry. */
export const Failed: Story = {
  parameters: {
    api: [
      apiFailure(getPlatformObservabilityContract, { pathParams: { accountId: orgAccount.id } }),
    ],
  },
}

/** A new account with no runs: every section says it has nothing for this window. */
export const Empty: Story = {
  parameters: {
    api: [
      figuresAre(
        platform({
          outcomes: {
            total: 0,
            done: 0,
            failed: 0,
            running: 0,
            blocked: 0,
            paused: 0,
            other: 0,
            successRate: null,
          },
          trend: { bucketMs: HOUR, points: [] },
          failures: [],
          gates: [],
          live: { running: 0, blocked: 0, paused: 0, pending: 0 },
          durations: {
            count: 0,
            avgMs: null,
            minMs: null,
            maxMs: null,
            p50Ms: null,
            p90Ms: null,
            p99Ms: null,
          },
        }),
      ),
    ],
  },
}

const staleThrough = NOW - 5 * DAY
const stalePoints = dailyTrend(30, staleThrough)
const staleDone = stalePoints.reduce((n, p) => n + p.done, 0)
const staleFailed = stalePoints.reduce((n, p) => n + p.failed, 0)

/** The failed runs split over the four failure kinds as in a day, the first kind takes the rest. */
function failuresOf(failed: number): PlatformObservability['failures'] {
  const dispatch = Math.round((failed * 2) / 7)
  const stalled = Math.round(failed / 7)
  const environment = Math.round(failed / 7)
  return [
    { kind: 'agent', count: failed - dispatch - stalled - environment },
    { kind: 'dispatch', count: dispatch },
    { kind: 'stalled', count: stalled },
    { kind: 'environment', count: environment },
  ]
}

/**
 * Thirty days from the daily rollup, which last ran five days ago: a warning names the date, so
 * the empty days at the end read as missing data, not as idle days. The outcomes and the failure
 * kinds are the sums of the trend's points.
 */
export const RollupStale: Story = {
  decorators: [withDashboard('30d')],
  parameters: {
    api: [
      figuresAre(
        platform({
          window: '30d',
          since: NOW - 30 * DAY,
          source: 'daily-rollup',
          rolledUpThrough: staleThrough,
          outcomes: {
            total: staleDone + staleFailed,
            done: staleDone,
            failed: staleFailed,
            running: 0,
            blocked: 0,
            paused: 0,
            other: 0,
            successRate: staleDone / (staleDone + staleFailed),
          },
          trend: { bucketMs: DAY, points: stalePoints },
          failures: failuresOf(staleFailed),
        }),
      ),
    ],
  },
}

/**
 * Ninety days, and the rollup has produced nothing yet: a warning says the outcomes are empty for
 * lack of data. The gates, the live runs and the durations still count, because the backend reads
 * them straight from the runs on every window (`PlatformObservabilityService` in orchestration).
 */
export const NoRollup: Story = {
  decorators: [withDashboard('90d')],
  parameters: {
    api: [
      figuresAre(
        platform({
          window: '90d',
          since: NOW - 90 * DAY,
          source: 'daily-rollup',
          rolledUpThrough: null,
          outcomes: {
            total: 0,
            done: 0,
            failed: 0,
            running: 0,
            blocked: 0,
            paused: 0,
            other: 0,
            successRate: null,
          },
          trend: { bucketMs: DAY, points: dailyTrend(90, 0) },
          failures: [],
        }),
      ),
    ],
  },
}
