import type {
  ReportActivityDimension,
  ReportSpendDimension,
  ReportWindow,
} from '@cat-factory/contracts'
import { REPORT_SLICE_LIMIT } from '@cat-factory/contracts'
import type {
  ReportActivityGroup,
  ReportSpendGroup,
  ReportSpendTrendBucket,
  ReportsRepository,
  SpendRollupRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { ReportsService } from './ReportsService.js'

// Which STORE answers a window's spend half, and what the projection says about it. The
// aggregates themselves are covered against real databases by the conformance suite; what is
// only decidable here is the routing, and the rule that a report never presents ledger numbers
// as durable ones or a rollup's coverage as complete.

const DAY = 24 * 60 * 60_000
const NOW = 1_000 * DAY

function group(key: string, meteredCost: number): ReportSpendGroup {
  return {
    key,
    label: null,
    inputTokens: 1,
    outputTokens: 1,
    calls: 1,
    meteredCost,
    subscriptionCost: 0,
  }
}

/** Records which dimensions each store was asked for, so the routing is observable. */
function fakes() {
  const asked = {
    ledger: [] as ReportSpendDimension[],
    rollup: [] as ReportSpendDimension[],
    activity: [] as ReportActivityDimension[],
  }
  const activity: ReportActivityGroup[] = []
  const trend: ReportSpendTrendBucket[] = []
  const reportsRepository: ReportsRepository = {
    spendByDimension: async (_scope, dimension) => {
      asked.ledger.push(dimension)
      return [group('from-ledger', 2)]
    },
    activityByDimension: async (_scope, dimension) => {
      asked.activity.push(dimension)
      return activity
    },
    spendTrend: async () => trend,
  }
  const spendRollupRepository: SpendRollupRepository = {
    rollupSpendDays: async () => 0,
    rollupWorkspaceSpendDays: async () => 0,
    spendRollupWatermark: async () => NOW - DAY,
    spendByDimension: async (_scope, dimension) => {
      asked.rollup.push(dimension)
      return [group('from-rollup', 3)]
    },
    spendTrend: async () => trend,
  }
  return { asked, reportsRepository, spendRollupRepository }
}

function service(deps: {
  reportsRepository: ReportsRepository
  spendRollupRepository?: SpendRollupRepository
}) {
  return new ReportsService({ ...deps, clock: { now: () => NOW }, currency: 'EUR' })
}

async function summarize(window: ReportWindow, withRollup: boolean) {
  const { asked, reportsRepository, spendRollupRepository } = fakes()
  const view = await service({
    reportsRepository,
    ...(withRollup ? { spendRollupRepository } : {}),
  }).summarize('acc_1', window)
  return { view, asked }
}

describe('ReportsService source routing', () => {
  it('scans the ledger on the short windows, where a sweep cadence would show as a missing tail', async () => {
    for (const window of ['24h', '7d'] as const) {
      const { view, asked } = await summarize(window, true)
      expect(view.source).toBe('ledger')
      expect(asked.rollup).toEqual([])
      expect(view.spend.byRepo[0]?.key).toBe('from-ledger')
      // Nothing in this path can be behind, so claiming a coverage boundary would invite the
      // reader to believe the live numbers were bounded by it.
      expect(view.rolledUpThrough).toBeNull()
    }
  })

  it('reads the durable rollup on the TCO windows, and says how far the sweep has covered', async () => {
    for (const window of ['30d', '90d'] as const) {
      const { view, asked } = await summarize(window, true)
      expect(view.source).toBe('daily-rollup')
      expect(asked.ledger).toEqual([])
      expect(view.spend.byRepo[0]?.key).toBe('from-rollup')
      expect(view.rolledUpThrough).toBe(NOW - DAY)
    }
  })

  it('falls back to the ledger when no rollup is wired, and SAYS so', async () => {
    // The ledger holds ~13 months, so the fallback is accurate until retention reaches it.
    // What it must not do is label those numbers durable: `source` is the reader's only way
    // to tell a deployment that keeps cost history from one that is about to lose it.
    const { view } = await summarize('90d', false)
    expect(view.source).toBe('ledger')
    expect(view.rolledUpThrough).toBeNull()
  })

  it('asks ONE store for every spend dimension, so no breakdown disagrees with the totals', async () => {
    // Every breakdown partitions the same rows and the totals fold from one of them; mixing
    // sources within a window would make the tiles and the cards describe different data.
    const { asked } = await summarize('30d', true)
    expect(asked.rollup).toEqual([
      'model',
      'agentKind',
      'workspace',
      'service',
      'repo',
      'taskType',
      'ticket',
      'run',
    ])
  })

  it('reads run ACTIVITY off the run table on every window', async () => {
    // Activity is not spend: it comes from `agent_runs` regardless of which store priced the
    // window, so a rollup that is a day behind never changes the run counts beside it.
    const { view } = await summarize('90d', true)
    expect(view.activity.byWorkspace).toEqual([])
  })

  it('asks the run table for every activity dimension the projection carries', async () => {
    // `repo` among them: several services can point at one repository and no read publishes
    // that mapping, so folding the service counts up to a repository is not something a
    // reader could do for itself.
    const { asked, reportsRepository, spendRollupRepository } = fakes()
    await service({ reportsRepository, spendRollupRepository }).summarize('acc_1', '7d')
    expect(asked.activity).toEqual(['workspace', 'service', 'repo', 'taskType'])
  })
})

describe('ReportsService activity-scaled caps', () => {
  /** A store whose every breakdown returns `count` slices, heaviest first. */
  function wideRepository(count: number): ReportsRepository {
    return {
      spendByDimension: async () =>
        Array.from({ length: count }, (_, i) => group(`slice-${i}`, count - i)),
      activityByDimension: async () => [],
      spendTrend: async () => [],
    }
  }

  it('serves the catalog-bounded dimensions whole and caps only the activity-scaled ones', async () => {
    const wide = REPORT_SLICE_LIMIT + 7
    const view = await service({ reportsRepository: wideRepository(wide) }).summarize('acc_1', '7d')
    // A model or an agent kind comes from a catalog and stays small on its own; capping it
    // would drop slices for nothing.
    expect(view.spend.byModel).toHaveLength(wide)
    expect(view.spend.byService).toHaveLength(wide)
    // `run` and `ticket` grow with activity instead, so a busy 90-day window is otherwise a
    // payload (and a DOM) nobody sized.
    expect(view.spend.byRun).toHaveLength(REPORT_SLICE_LIMIT)
    expect(view.spend.byTicket).toHaveLength(REPORT_SLICE_LIMIT)
    expect(view.capped).toEqual([
      { dimension: 'ticket', returned: REPORT_SLICE_LIMIT, omitted: 7 },
      { dimension: 'run', returned: REPORT_SLICE_LIMIT, omitted: 7 },
    ])
  })

  it('keeps the window totals over the WHOLE population a cap trimmed', async () => {
    // What a cap costs the reader is the identity of the tail, never its money. The totals
    // fold from the uncapped model breakdown, so the share the shown slices account for stays
    // computable and a capped list can never read as the whole window.
    const wide = REPORT_SLICE_LIMIT + 7
    const view = await service({ reportsRepository: wideRepository(wide) }).summarize('acc_1', '7d')
    expect(view.totals.calls).toBe(wide)
    const shown = view.spend.byRun.reduce((sum, row) => sum + row.calls, 0)
    expect(shown).toBeLessThan(view.totals.calls)
  })

  it('announces nothing when every breakdown fits, so an empty list means complete', async () => {
    const view = await service({ reportsRepository: wideRepository(3) }).summarize('acc_1', '7d')
    expect(view.capped).toEqual([])
  })
})

describe('ReportsService.breakdown', () => {
  async function breakdown(window: ReportWindow, dimension: ReportSpendDimension, limit?: number) {
    const { asked, reportsRepository, spendRollupRepository } = fakes()
    const result = await service({ reportsRepository, spendRollupRepository }).breakdown(
      'acc_1',
      dimension,
      window,
      'ws_1',
      limit,
    )
    return { result, asked }
  }

  it('routes ONE dimension through the same store the whole report would have used', async () => {
    // The single-dimension read exists to cost one GROUP BY instead of eleven; what it must not
    // do is answer from a different store than the panel, or a repository's quarterly cost would
    // change with which surface asked for it.
    const live = await breakdown('7d', 'repo')
    expect(live.result.source).toBe('ledger')
    // No activity aggregate either: a single-dimension read is one GROUP BY, not eleven.
    expect(live.asked).toEqual({ ledger: ['repo'], rollup: [], activity: [] })
    expect(live.result.rolledUpThrough).toBeNull()

    const durable = await breakdown('90d', 'ticket')
    expect(durable.result.source).toBe('daily-rollup')
    expect(durable.asked).toEqual({ ledger: [], rollup: ['ticket'], activity: [] })
    expect(durable.result.rolledUpThrough).toBe(NOW - DAY)
  })

  it('folds the totals over the WHOLE window, then caps the rows', async () => {
    // The property that makes a capped public breakdown honest rather than a smaller number
    // that reads as complete: the tail leaves `rows`, and none of its money leaves `totals`.
    // Two slices, one row asked for: the heavy one is kept (the port orders heaviest-first and
    // the cap is a prefix of that order), the light one's spend still lands in the total.
    const { reportsRepository, spendRollupRepository } = fakes()
    reportsRepository.spendByDimension = async () => [group('heavy', 9), group('light', 1)]
    const capped = await service({ reportsRepository, spendRollupRepository }).breakdown(
      'acc_1',
      'run',
      '7d',
      'ws_1',
      1,
    )
    expect(capped.rows.map((row) => row.key)).toEqual(['heavy'])
    expect(capped.truncated).toBe(true)
    expect(capped.totals.meteredCost).toBe(10)
    expect(capped.totals.calls).toBe(2)

    // And a limit the window does not reach is NOT a truncation: `rows.length === limit` cannot
    // tell the two apart, which is why the flag is computed rather than inferred downstream.
    const exact = await service({ reportsRepository, spendRollupRepository }).breakdown(
      'acc_1',
      'run',
      '7d',
      'ws_1',
      2,
    )
    expect(exact.truncated).toBe(false)
    expect(exact.rows).toHaveLength(2)
  })

  it('folds the totals from the rows it returns, so the two cannot disagree', async () => {
    const { result } = await breakdown('7d', 'run')
    expect(result.rows).toEqual([
      {
        key: 'from-ledger',
        label: null,
        inputTokens: 1,
        outputTokens: 1,
        calls: 1,
        meteredCost: 2,
        subscriptionCost: 0,
      },
    ])
    expect(result.totals).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      calls: 1,
      meteredCost: 2,
      subscriptionCost: 0,
    })
  })

  it('reports the SNAPPED window start the numbers were actually computed over', async () => {
    // Not `generatedAt - windowMs`: the start is snapped down to a bucket edge so a slice read
    // here covers the identical span the panel's own aggregate does. A caller that re-derived it
    // from `window` would name a span up to one bucket shorter than the one it is holding.
    const { result } = await breakdown('30d', 'repo')
    expect(result.generatedAt).toBe(NOW)
    expect(result.since).toBe(NOW - 30 * DAY)
    expect(result.since % DAY).toBe(0)
    expect(result.currency).toBe('EUR')
  })
})
