import type { ReportSpendDimension } from '@cat-factory/contracts'
import type {
  ReportRange,
  ReportScope,
  ReportSpendGroup,
  ReportsRepository,
  SpendRollupRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { type ReportsSeed, seedReportsFixture } from './reports-suite.js'

// Cross-runtime parity for the DURABLE cost-attribution rollup (`spend_days`), on the same
// fixture the ledger-side reports suite uses, because the load-bearing property is not that
// the two dialects agree with each other but that BOTH agree with the ledger they stand in
// for. The Reports view routes between them by window, so a rollup that folded one row
// differently, attributed a multi-linked block to a different ticket, or fanned an aggregate
// out across a colliding frame block would make the same account's spend change the moment a
// reader switched from `7d` to `30d`.
//
// The other half of the suite is what the ledger CANNOT do: the attribution has to survive the
// ledger row, the run row and the ticket link that produced it. That is the whole reason the
// table exists, and it is only observable by deleting those rows and reading again.

const DAY = 24 * 60 * 60 * 1000

/**
 * The raw seed seam, plus the one destructive helper this suite needs: dropping the sources a
 * report would otherwise join through, which is what retention (and an ordinary board tidy-up)
 * does over time.
 */
export interface SpendRollupSeed extends ReportsSeed {
  /**
   * Delete the ledger rows, run rows and imported tickets of the given workspaces: the
   * ledger pruned to its window, a run reaped, an issue re-imported. Everything the live read
   * resolves attribution through, gone.
   */
  forgetSources(workspaceIds: string[]): Promise<void>
}

/** Every spend dimension, so a new one cannot be added to one source and forgotten in the other. */
const DIMENSIONS: ReportSpendDimension[] = [
  'model',
  'agentKind',
  'workspace',
  'service',
  'repo',
  'taskType',
  'ticket',
  'run',
]

/** Compare two breakdowns exactly: same slices, same order, same money. */
function expectSameBreakdown(actual: ReportSpendGroup[], expected: ReportSpendGroup[]) {
  expect(actual.map((r) => r.key)).toEqual(expected.map((r) => r.key))
  for (const [i, row] of actual.entries()) {
    const want = expected[i]
    expect(row.label).toEqual(want?.label ?? null)
    expect(row.calls).toBe(want?.calls)
    expect(row.inputTokens).toBe(want?.inputTokens)
    expect(row.outputTokens).toBe(want?.outputTokens)
    expect(row.meteredCost).toBeCloseTo(want?.meteredCost ?? 0, 6)
    expect(row.subscriptionCost).toBeCloseTo(want?.subscriptionCost ?? 0, 6)
  }
}

export function defineSpendRollupSuite(
  name: string,
  makeRepos: () => { reports: ReportsRepository; rollup: SpendRollupRepository },
  makeSeed: () => SpendRollupSeed,
): void {
  describe(`[${name}] durable spend rollup parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-sr-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { account: `acc-${tag}`, ws: `ws-${tag}`, tag }
    }
    // The fixture's own timestamps are absolute (1_000 … 10_000), so it seeds inside UTC day 0
    // and its deliberately-out-of-window rows sit outside `seedRange`. The rollup is read on a
    // DAY-aligned window, which is what the report windows this table serves always are:
    // `alignWindowStart` snaps them to a multiple of one day (`30d`) or three (`90d`).
    const seedRange: ReportRange = { since: 1_000, until: 10_000 }
    const dayRange: ReportRange = { since: 0, until: DAY }
    const scopeOf = (accountId: string, workspaceId?: string): ReportScope => ({
      accountId,
      workspaceId: workspaceId ?? null,
    })
    const seedFixture = (seed: SpendRollupSeed) => seedReportsFixture(seed, ids, seedRange)

    it('reports every dimension exactly as the ledger does, once materialised', async () => {
      const { reports, rollup } = makeRepos()
      const { account } = await seedFixture(makeSeed())
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      for (const dimension of DIMENSIONS) {
        expectSameBreakdown(
          await rollup.spendByDimension(scopeOf(account), dimension, dayRange),
          await reports.spendByDimension(scopeOf(account), dimension, dayRange),
        )
      }
    })

    it('keeps the attribution after the ledger, the runs and the tickets are gone', async () => {
      // The point of the table. A live read resolves a repository or a ticket by joining rows
      // that retention prunes and an operator re-points; this one froze them while the money
      // was being spent, so the same question asked a year later gets the same answer.
      const { reports, rollup } = makeRepos()
      const seed = makeSeed()
      const { account, ws, wsB } = await seedFixture(seed)
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      const before = new Map(
        await Promise.all(
          DIMENSIONS.map(
            async (d) => [d, await rollup.spendByDimension(scopeOf(account), d, dayRange)] as const,
          ),
        ),
      )

      await seed.forgetSources([ws, wsB])

      for (const dimension of DIMENSIONS) {
        // The ledger now knows nothing at all…
        expect(await reports.spendByDimension(scopeOf(account), dimension, dayRange)).toEqual([])
        // …and the rollup answers exactly what it did before, labels included.
        expectSameBreakdown(
          await rollup.spendByDimension(scopeOf(account), dimension, dayRange),
          before.get(dimension) ?? [],
        )
      }
    })

    it('REWRITES the window rather than accumulating it', async () => {
      // An upsert is not a rewrite, and this table is never pruned, so a bucket the new result
      // set no longer produces would double-count for the life of the deployment. Rolling the
      // same window twice must be a no-op, and a ledger row that disappears must take its
      // money with it.
      const { reports, rollup } = makeRepos()
      const seed = makeSeed()
      const { account, ws, wsB } = await seedFixture(seed)
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      const once = await rollup.spendByDimension(scopeOf(account), 'model', dayRange)
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      expectSameBreakdown(await rollup.spendByDimension(scopeOf(account), 'model', dayRange), once)

      await seed.forgetSources([ws, wsB])
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      expect(await rollup.spendByDimension(scopeOf(account), 'model', dayRange)).toEqual([])
      expect(await reports.spendByDimension(scopeOf(account), 'model', dayRange)).toEqual([])
    })

    it('bucketises the trend on rolled-up days and zero-fills nothing', async () => {
      const { reports, rollup } = makeRepos()
      const { account } = await seedFixture(makeSeed())
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      const rolled = await rollup.spendTrend(scopeOf(account), dayRange, DAY)
      const ledger = await reports.spendTrend(scopeOf(account), dayRange, DAY)
      expect(rolled.map((b) => b.bucketStart)).toEqual(ledger.map((b) => b.bucketStart))
      expect(rolled[0]?.calls).toBe(ledger[0]?.calls)
      expect(rolled[0]?.meteredCost).toBeCloseTo(ledger[0]?.meteredCost ?? 0, 6)
      expect(rolled[0]?.subscriptionCost).toBeCloseTo(ledger[0]?.subscriptionCost ?? 0, 6)
    })

    it('scopes to the account, and narrows to one board on request', async () => {
      // The scope rides the row's OWN frozen `account_id`, not a `workspaces` sub-select, so
      // this is a different code path from the ledger's and needs its own assertion.
      const { rollup } = makeRepos()
      const { account, ws, other } = await seedFixture(makeSeed())
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      const wholeAccount = await rollup.spendByDimension(scopeOf(account), 'workspace', dayRange)
      expect(wholeAccount.length).toBeGreaterThan(1)
      const oneBoard = await rollup.spendByDimension(scopeOf(account, ws), 'workspace', dayRange)
      expect(oneBoard.map((r) => r.key)).toEqual([ws])
      // A foreign account sees none of it, and a foreign board id simply matches nothing.
      expect(await rollup.spendByDimension(scopeOf(other.account), 'model', dayRange)).toEqual([])
      expect(await rollup.spendByDimension(scopeOf(account, other.ws), 'model', dayRange)).toEqual(
        [],
      )
    })

    it('excludes days outside the window on both bounds', async () => {
      const { rollup } = makeRepos()
      const { account } = await seedFixture(makeSeed())
      await rollup.rollupSpendDays(dayRange.since, dayRange.until)
      // The fixture's spend is all in day 0; a window starting the next day sees none of it,
      // and one ending at day 0 sees none either (the range is half-open on `day_start`).
      expect(
        await rollup.spendByDimension(scopeOf(account), 'model', { since: DAY, until: 2 * DAY }),
      ).toEqual([])
      expect(
        await rollup.spendByDimension(scopeOf(account), 'model', { since: -DAY, until: 0 }),
      ).toEqual([])
    })

    it('records the sweep coverage forward-only, so a catch-up pass cannot walk it back', async () => {
      // The watermark answers "how far has the SWEEP got", which is why it is recorded by the
      // pass rather than derived from the rows: an account that spent nothing and a wedged
      // sweep produce the same newest row and need opposite responses. Deployment-scoped, so
      // this asserts the RELATION between passes rather than an absolute value.
      const { rollup } = makeRepos()
      await seedFixture(makeSeed())
      await rollup.rollupSpendDays(0, 3 * DAY)
      const ahead = await rollup.spendRollupWatermark()
      expect(ahead).not.toBeNull()
      expect(ahead ?? 0).toBeGreaterThanOrEqual(2 * DAY)

      await rollup.rollupSpendDays(0, DAY)
      expect(await rollup.spendRollupWatermark()).toBe(ahead)
    })

    it('writes nothing for an empty or inverted window', async () => {
      const { rollup } = makeRepos()
      expect(await rollup.rollupSpendDays(2 * DAY, DAY)).toBe(0)
    })
  })
}
